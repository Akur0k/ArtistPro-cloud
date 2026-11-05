import { releaseCanvas, tileRange, TILE } from './Frame.js';

// Undo keeps tiles: before an edit draws anywhere, the tool calls
// touch(rect) and every tile of that rect not saved yet is copied (or
// noted as absent) — so a brush stroke keeps only the tiles it crossed.
// A snapshot is { tx, ty, canvas } (canvas null: no tile there).
const TILE_BYTES = TILE * TILE * 4;
// all snapshots kept for undo/redo together — the oldest steps go first
const MAX_HISTORY_BYTES = 96 * 1024 * 1024;

const bytesOf = snaps => snaps.reduce((n, s) => n + (s.canvas ? TILE_BYTES : 0), 0);

const pieceBytes = p => (p.canvas ? p.canvas.width * p.canvas.height * 4 : 0);

function entryBytes(entry) {
  if (entry.type === 'object') return 0;
  if (entry.type === 'objectPiece') return pieceBytes(entry.before) + pieceBytes(entry.after);
  if (entry.type === 'patch') return bytesOf(entry.tiles);
  let n = 0;
  for (const op of entry.ops) if (op.kind === 'edit') n += bytesOf(op.before) + bytesOf(op.after);
  return n;
}

function releaseSnaps(snaps) {
  for (const s of snaps) releaseCanvas(s.canvas);
}

// frees the snapshot canvases an entry holds once it can't be used again
function releaseEntry(entry) {
  if (!entry || entry.type === 'object') return;
  if (entry.type === 'objectPiece') {
    releaseCanvas(entry.before.canvas);
    releaseCanvas(entry.after.canvas);
    return;
  }
  if (entry.type === 'patch') {
    releaseSnaps(entry.tiles);
  } else {
    for (const op of entry.ops) {
      if (op.kind === 'edit') {
        releaseSnaps(op.before);
        releaseSnaps(op.after);
      }
    }
  }
}

function snapshotRect(frame, rect) {
  const out = [];
  const { tx0, ty0, tx1, ty1 } = tileRange(rect);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push(frame.snapshotTile(tx, ty));
  return out;
}

function restore(frame, snaps) {
  for (const s of snaps) frame.restoreTile(s);
}

export class History {
  constructor(limit = 15) {
    this.undoStack = [];
    this.redoStack = [];
    this.limit = limit;
    this.pendingLayer = null;
    this.pendingFrameIndex = null;
    this.pendingFrame = null;
    this.pendingTiles = null; // Map "tx,ty" -> snapshot
    this.pendingBatch = null;
  }

  // ---- single-frame pixel-edit entries (brush/eraser/fill/clear/selection) ----

  // returns false (nothing started) if the frame's pixels aren't decoded
  // yet. guide: the edit is to the frame's fill borders, not its picture
  begin(layer, frameIndex, { guide = false } = {}) {
    const frame = guide ? layer.frames[frameIndex]?.guideFrame(true) : layer.frames[frameIndex];
    if (!frame?.ensureResident()) return false;
    this._releasePending();
    this.pendingLayer = layer;
    this.pendingFrameIndex = frameIndex;
    this.pendingGuide = guide;
    this.pendingFrame = frame;
    this.pendingTiles = new Map();
    return true;
  }

  // about to change pixels inside rect (layer pixels): saves what's there
  // first, tile by tile
  touch(rect) {
    if (!this.pendingTiles || !rect) return;
    const frame = this.pendingFrame;
    const { tx0, ty0, tx1, ty1 } = tileRange(rect);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx},${ty}`;
        if (!this.pendingTiles.has(key)) this.pendingTiles.set(key, frame.snapshotTile(tx, ty));
      }
    }
  }

  // every tile the frame has — for edits that can change anything (clear)
  touchAll() {
    if (!this.pendingFrame) return;
    for (const t of this.pendingFrame.tiles.values()) {
      const key = `${t.tx},${t.ty}`;
      if (!this.pendingTiles.has(key)) this.pendingTiles.set(key, this.pendingFrame.snapshotTile(t.tx, t.ty));
    }
  }

  commit() {
    if (!this.pendingTiles) return;
    const tiles = [...this.pendingTiles.values()];
    if (tiles.length) {
      this._push({
        type: 'patch',
        layerId: this.pendingLayer.id,
        frameIndex: this.pendingFrameIndex,
        guide: this.pendingGuide,
        tiles,
      });
      this._clearRedo();
      this.pendingFrame.markDirty();
    }
    this._clearPending();
  }

  // puts the frame back the way begin() found it, but stays pending
  revertPending() {
    if (!this.pendingTiles) return;
    restore(this.pendingFrame, this.pendingTiles.values());
  }

  discardPending() {
    if (!this.pendingTiles) return;
    this.pendingLayer.setActiveFrame(this.pendingFrameIndex);
    this.revertPending();
    this._releasePending();
  }

  cancelPending() {
    this._releasePending();
  }

  // the layer is gone for good — its undo/redo steps can never apply again
  // (they'd just be taps that do nothing), so drop them
  forgetLayer(layerId) {
    const keep = entry => {
      if (entry.layerId !== layerId) return true;
      releaseEntry(entry);
      return false;
    };
    this.undoStack = this.undoStack.filter(keep);
    this.redoStack = this.redoStack.filter(keep);
  }

  // memory held by undo/redo snapshots
  totalBytes() {
    let total = 0;
    for (const e of this.undoStack) total += entryBytes(e);
    for (const e of this.redoStack) total += entryBytes(e);
    if (this.pendingTiles) total += bytesOf([...this.pendingTiles.values()]);
    return total;
  }

  _push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) releaseEntry(this.undoStack.shift());
    // a memory cap too: a few edits over huge areas mustn't pile up
    let total = this.totalBytes();
    while (total > MAX_HISTORY_BYTES && this.undoStack.length > 1) {
      const old = this.undoStack.shift();
      total -= entryBytes(old);
      releaseEntry(old);
    }
  }

  // an object layer's keys changed (before / after: copies of its keys)
  recordObject(layer, before, after) {
    this._clearRedo();
    this._push({ type: 'object', layerId: layer.id, before, after });
  }

  // drawn on an object layer's picture: before / after — { canvas (a
  // copy, kept as it is), w, h, keys } (growing the picture moves its keys)
  recordObjectPiece(layer, before, after) {
    this._clearRedo();
    this._push({ type: 'objectPiece', layerId: layer.id, before, after });
  }

  _clearRedo() {
    for (const entry of this.redoStack) releaseEntry(entry);
    this.redoStack = [];
  }

  _releasePending() {
    if (this.pendingTiles) releaseSnaps(this.pendingTiles.values());
    this._clearPending();
  }

  _clearPending() {
    this.pendingLayer = null;
    this.pendingFrameIndex = null;
    this.pendingFrame = null;
    this.pendingTiles = null;
  }

  // ---- batch entries: frame-structural ops (insert/remove/move/edit),
  // grouped so add-frame / remove-frame / reorder / tween each undo as one step ----

  beginBatch(layer, anchorFrameIndex) {
    this.pendingBatch = { layer, anchorFrameIndex, ops: [] };
  }

  // pixel edit to an existing (resident) frame within a batch, over rect
  // (layer pixels). Call beginEdit before mutating, then finishEdit after,
  // passing back what beginEdit returned.
  beginEdit(frameIndex, rect) {
    const frame = this.pendingBatch.layer.frames[frameIndex];
    return { rect, before: snapshotRect(frame, rect) };
  }

  finishEdit(frameIndex, begun) {
    const frame = this.pendingBatch.layer.frames[frameIndex];
    const after = snapshotRect(frame, begun.rect);
    this.pendingBatch.ops.push({ kind: 'edit', frameIndex, before: begun.before, after });
    frame.markDirty();
  }

  // frame: the Frame object that was inserted / removed. Undo/redo moves
  // that same object in and out of the layer, so no pixels are copied and
  // an encoded frame stays encoded while it waits in the history.
  recordInsert(index, frame) {
    this.pendingBatch.ops.push({ kind: 'insert', index, frame });
  }

  recordRemove(index, frame) {
    this.pendingBatch.ops.push({ kind: 'remove', index, frame });
  }

  // the layer laid out anew (Layer.setLayout): before / after — { start, frames }
  recordLayout(before, after) {
    this.pendingBatch.ops.push({ kind: 'layout', before, after });
  }

  // the layer's start (Layer.start) moved
  recordStart(from, to) {
    this.pendingBatch.ops.push({ kind: 'start', from, to });
  }

  recordMove(from, to) {
    this.pendingBatch.ops.push({ kind: 'move', from, to });
  }

  commitBatch() {
    if (!this.pendingBatch || this.pendingBatch.ops.length === 0) {
      this.pendingBatch = null;
      return;
    }
    this._push({
      type: 'batch',
      layerId: this.pendingBatch.layer.id,
      anchorFrameIndex: this.pendingBatch.anchorFrameIndex,
      ops: this.pendingBatch.ops,
    });
    this._clearRedo();
    this.pendingBatch = null;
  }

  cancelBatch() {
    this.pendingBatch = null;
  }

  // ---- undo/redo, dispatching on entry type ----
  // async: the frame being restored may first need decoding

  async undo(layerManager) {
    const entry = this.undoStack.pop();
    if (!entry) return;
    const reverse = await this._apply(layerManager, entry, true);
    if (reverse) this.redoStack.push(reverse);
  }

  async redo(layerManager) {
    const entry = this.redoStack.pop();
    if (!entry) return;
    const reverse = await this._apply(layerManager, entry, false);
    if (reverse) this.undoStack.push(reverse);
  }

  // returns the entry to push onto the opposite stack, or null if the
  // entry no longer applies (its layer was deleted)
  async _apply(layerManager, entry, inverse) {
    const layer = layerManager.getLayer(entry.layerId);
    if (!layer) return null;

    if (entry.type === 'batch') {
      await this._applyBatch(layer, entry, inverse);
      return entry;
    }
    if (entry.type === 'objectPiece') {
      const snap = inverse ? entry.before : entry.after;
      const c = document.createElement('canvas');
      c.width = snap.canvas.width;
      c.height = snap.canvas.height;
      c.getContext('2d').drawImage(snap.canvas, 0, 0);
      Object.assign(layer.piece, { canvas: c, w: snap.w, h: snap.h, dirty: true });
      layer.keys = snap.keys.map(k => ({ ...k }));
      layer.syncToTime(layerManager.playhead);
      return entry;
    }
    if (entry.type === 'object') {
      layer.keys = (inverse ? entry.before : entry.after).map(k => ({ ...k }));
      layer.syncToTime(layerManager.playhead);
      return entry;
    }

    layer.setActiveFrame(entry.frameIndex);
    const owner = layer.frames[entry.frameIndex];
    const frame = entry.guide ? owner?.guideFrame(true) : owner;
    if (!frame) return null;
    await frame.load(true);
    // the same tiles as they are now — what going back the other way restores
    const reverse = { type: 'patch', layerId: layer.id, frameIndex: entry.frameIndex, guide: entry.guide, tiles: entry.tiles.map(s => frame.snapshotTile(s.tx, s.ty)) };
    restore(frame, entry.tiles);
    // this entry is spent — `reverse` holds what's needed to go back
    releaseSnaps(entry.tiles);
    return reverse;
  }

  // inverse=true replays ops in reverse, undoing each; inverse=false replays
  // forward, redoing each
  async _applyBatch(layer, entry, inverse) {
    const ops = inverse ? [...entry.ops].reverse() : entry.ops;
    for (const op of ops) {
      if (op.kind === 'edit') {
        const frame = layer.frames[op.frameIndex];
        await frame.load(true);
        restore(frame, inverse ? op.before : op.after);
      } else if (op.kind === 'insert') {
        if (inverse) layer.removeFrame(op.index);
        else layer.insertFrameObject(op.index, op.frame);
      } else if (op.kind === 'remove') {
        if (inverse) layer.insertFrameObject(op.index, op.frame);
        else layer.removeFrame(op.index);
      } else if (op.kind === 'move') {
        if (inverse) layer.moveFrame(op.to, op.from);
        else layer.moveFrame(op.from, op.to);
      } else if (op.kind === 'start') {
        layer.start = inverse ? op.from : op.to;
      } else if (op.kind === 'layout') {
        const l = inverse ? op.before : op.after;
        layer.setLayout(l.start, [...l.frames]);
      }
    }
    layer.setActiveFrame(Math.max(0, Math.min(entry.anchorFrameIndex, layer.frameCount - 1)));
  }
}
