// A frame's pixels live on an unbounded grid of TILE×TILE tiles (layer
// pixels; tile tx,ty covers tx*TILE … (tx+1)*TILE, relative to the camera's
// top-left corner). Only tiles that were drawn on exist, so the drawing
// area is infinite and a frame costs memory only where it has content.
//
// Each tile is either decoded (canvas — drawable, what the screen shows)
// or encoded (blob — compact, what gets saved), or both. A frame is
// resident when all its tiles are decoded. Only a bounded working set of
// frames is kept resident — each layer's current frame (plus a few ahead
// during playback, its neighbours with onion skin on; see
// Layer.keepFrames()). Everything else is encoded (if it changed) and its
// canvases dropped.
//
// Frames often hold the very same picture — copies, a frame pulled longer,
// a movement that stands still. A decoded tile is shared by every tile
// whose encoded picture has the same bytes (shared: read only — drawing on
// it gives the tile a canvas of its own first), so 40 copies of a picture
// cost the memory of one.
//
// A frame can also hold a single image covering one rectangle — "legacy":
// projects saved before tiles, and imported video frames. It's split into
// tiles when the frame becomes resident, and stays the stored form until
// the frame is edited.

import { dlog } from './DebugLog.js';
import { blobKey } from './BlobKey.js';

export const TILE = 512;
const TILE_BYTES = TILE * TILE * 4;
const MEMORY_BUDGET_BYTES = 192 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

const resident = new Set();
let clock = 0;
let keepProvider = () => [];
let enforceScheduled = false;
let enforcing = false;
let enforceAgain = false;
let invalidate = () => {};

// LayerManager registers the frames that must stay resident right now
export function setKeepProvider(fn) {
  keepProvider = fn;
}

// the screen (Display) registers how to request a redraw
export function setInvalidate(fn) {
  invalidate = fn;
}

export function invalidateDisplay() {
  invalidate();
}

// decoding lots of images at once (a timeline full of thumbnails) would
// spike memory — run at most a couple at a time, urgent ones (the frame the
// user is looking at) first.
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn, urgent = false) => new Promise((resolve, reject) => {
    const job = { fn, resolve, reject };
    if (urgent) queue.unshift(job);
    else queue.push(job);
    next();
  });
}

const decodeLimit = makeLimiter(2);

// size: null (full) or { width, height }
function decodeBlob(blob, size = null, urgent = false) {
  return decodeLimit(async () => {
    if (size) {
      try {
        return await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'low' });
      } catch {
        // resize options unsupported — fall through to a full decode
      }
    }
    return createImageBitmap(blob);
  }, urgent);
}

// Safari counts a canvas against its (hard, per-page) canvas memory limit
// until garbage collection gets round to it, which can be much later — and
// past the limit new canvases silently come out blank. Shrinking a canvas
// we're done with frees its memory immediately. Never for one still shown.
export function releaseCanvas(canvas) {
  if (!canvas || canvas.isConnected) return;
  canvas.width = 0;
  canvas.height = 0;
}

export function encodeCanvas(canvas, encoding) {
  const type = encoding === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Не удалось закодировать кадр'))), type, JPEG_QUALITY);
  });
}

export function newTileCanvas() {
  const c = document.createElement('canvas');
  c.width = TILE;
  c.height = TILE;
  if (!c.getContext('2d')) dlog('canvas-failed', { tile: true, stats: residentStats() });
  return c;
}

export function isTransparent(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}

const keyOf = (tx, ty) => `${tx},${ty}`;

// ---- decoded tiles shared between frames ----

const sharedTiles = new Map(); // picture key (BlobKey) -> { key, canvas, users }
const decoding = new Map(); // picture key -> Promise of its entry

// the decoded picture of blob, shared — the caller holds one use of it
async function shareDecoded(blob, urgent) {
  const key = await blobKey(blob);
  let entry = sharedTiles.get(key);
  if (!entry) {
    let p = decoding.get(key);
    if (!p) {
      p = (async () => {
        const bitmap = await decodeBlob(blob, null, urgent);
        const canvas = newTileCanvas();
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const e = { key, canvas, users: 0 };
        sharedTiles.set(key, e);
        return e;
      })();
      decoding.set(key, p);
      p.finally(() => decoding.delete(key)).catch(() => {});
    }
    entry = await p;
  }
  entry.users++;
  return entry;
}

function unuse(entry) {
  if (--entry.users > 0) return;
  sharedTiles.delete(entry.key);
  releaseCanvas(entry.canvas);
}

// a tile lets go of its decoded pixels (its own, or its use of shared ones)
function dropCanvas(t) {
  if (t.shared) unuse(t.shared);
  else releaseCanvas(t.canvas);
  t.canvas = null;
  t.shared = null;
}

// about to draw on t: pixels of its own (a copy of the shared ones)
function own(t) {
  if (!t.shared) return;
  const c = newTileCanvas();
  c.getContext('2d').drawImage(t.shared.canvas, 0, 0);
  unuse(t.shared);
  t.shared = null;
  t.canvas = c;
}

// decoded pixels in memory: every tile's own canvas, each shared one once
function residentBytes() {
  let n = sharedTiles.size;
  for (const f of resident) for (const t of f.tiles.values()) if (t.canvas && !t.shared) n++;
  return n * TILE_BYTES;
}

// tile coordinates of every tile touching rect (layer pixels)
export function tileRange(r) {
  return {
    tx0: Math.floor(r.x / TILE),
    ty0: Math.floor(r.y / TILE),
    tx1: Math.floor((r.x + r.w - 1) / TILE),
    ty1: Math.floor((r.y + r.h - 1) / TILE),
  };
}

export function intersectRect(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// a saved extent (fractions of the camera, so it survives a different
// pixel ratio) → layer pixels; null → the camera
export function extentFromRect(owner, rect) {
  const { pixelWidth: pw, pixelHeight: ph } = owner;
  if (!rect) return { x: 0, y: 0, w: pw, h: ph };
  return {
    x: Math.round(rect.x * pw),
    y: Math.round(rect.y * ph),
    w: Math.max(1, Math.round(rect.w * pw)),
    h: Math.max(1, Math.round(rect.h * ph)),
  };
}

export function rectFromExtent(owner, e) {
  return { x: e.x / owner.pixelWidth, y: e.y / owner.pixelHeight, w: e.w / owner.pixelWidth, h: e.h / owner.pixelHeight };
}

export class Frame {
  // owner supplies pixelWidth / pixelHeight / dpr / encoding (the Layer).
  // blob + extent (layer pixels, the camera if omitted): a single image
  // covering that rect (see "legacy" above)
  constructor(owner, duration = 1, blob = null, extent = null) {
    this.owner = owner;
    this.duration = duration;
    this.legacy = blob ? { blob, extent: extent ?? { x: 0, y: 0, w: owner.pixelWidth, h: owner.pixelHeight } } : null;
    this.tiles = new Map(); // "tx,ty" -> { tx, ty, canvas, blob, dirty, v }
    this.resident = false;
    this.dirty = false; // has changes not encoded yet
    this.version = 0;
    this.pins = 0; // > 0 while something holds on to the pixels
    this.attached = true;
    this.lastUsed = 0;
    this._loading = null;
    this._evicting = false;
    this._encoding = null;
    // fill borders drawn for this frame (a frame of their own: lines the
    // bucket stops at, never exported) — see guideFrame()
    this.guide = null;
    this.isGuide = false;
  }

  // the frame's fill borders; created on demand
  guideFrame(create = false) {
    if (!this.guide && create) {
      this.guide = new Frame(this.owner, this.duration);
      this.guide.isGuide = true;
    }
    return this.guide;
  }

  // tiles: [{ x, y, blob }] as saved
  static fromTiles(owner, duration, tiles) {
    const f = new Frame(owner, duration);
    for (const t of tiles) f.tiles.set(keyOf(t.x, t.y), { tx: t.x, ty: t.y, canvas: null, shared: null, blob: t.blob, dirty: false, v: 0 });
    return f;
  }

  // a new frame with the same pixels: encoded tiles are shared (blobs
  // never change), decoded ones copied
  copy(duration = 1) {
    const f = this.legacy
      ? new Frame(this.owner, duration, this.legacy.blob, { ...this.legacy.extent })
      : this._copyTiles(duration);
    if (this.guide && !this.guide.isBlank) {
      f.guide = this.guide._copyTiles(duration);
      f.guide.isGuide = true;
    }
    return f;
  }

  _copyTiles(duration) {
    const f = new Frame(this.owner, duration);
    for (const [k, t] of this.tiles) {
      let canvas = null;
      let shared = null;
      if (t.shared) {
        // the same picture: one more use of it
        shared = t.shared;
        shared.users++;
        canvas = shared.canvas;
      } else if (t.canvas) {
        canvas = newTileCanvas();
        canvas.getContext('2d').drawImage(t.canvas, 0, 0);
      }
      // a tile with changes not encoded yet has no usable blob
      const blob = t.dirty ? null : t.blob;
      if (!canvas && !blob) continue;
      f.tiles.set(k, { tx: t.tx, ty: t.ty, canvas, shared, blob, dirty: !blob, v: 0 });
    }
    if (this.resident) {
      f.dirty = [...f.tiles.values()].some(t => t.dirty);
      f._becomeResident();
    }
    return f;
  }

  get isBlank() {
    return !this.legacy && this.tiles.size === 0;
  }

  get byteSize() {
    let n = 0;
    for (const t of this.tiles.values()) if (t.canvas) n++;
    return n * TILE_BYTES; // (shared tiles too — what this frame uses)
  }

  touch() {
    this.lastUsed = ++clock;
  }

  get _needsDecode() {
    if (this.legacy && this.tiles.size === 0) return true;
    for (const t of this.tiles.values()) if (!t.canvas) return true;
    return false;
  }

  // synchronous: whether the pixels can be read/edited right now. A frame
  // that still needs decoding returns false (call load() and retry).
  ensureResident() {
    if (this.resident) {
      this.touch();
      return true;
    }
    if (this._needsDecode) return false;
    this._becomeResident();
    return true;
  }

  // old name, used by History
  canvasForEdit() {
    return this.ensureResident();
  }

  _becomeResident() {
    this.resident = true;
    resident.add(this);
    this.touch();
    scheduleEnforce();
  }

  load(urgent = false) {
    if (this.ensureResident()) return Promise.resolve(true);
    if (!this._loading) {
      this._loading = (async () => {
        if (this.legacy && this.tiles.size === 0) {
          const { blob, extent: e } = this.legacy;
          const bitmap = await decodeBlob(blob, null, urgent);
          if (this.legacy?.blob === blob && this.tiles.size === 0) {
            const { tx0, ty0, tx1, ty1 } = tileRange(e);
            for (let ty = ty0; ty <= ty1; ty++) {
              for (let tx = tx0; tx <= tx1; tx++) {
                const canvas = newTileCanvas();
                // scaled: an old project saved at another pixel ratio
                canvas.getContext('2d').drawImage(bitmap, e.x - tx * TILE, e.y - ty * TILE, e.w, e.h);
                // straight from the legacy image — nothing to encode until edited
                this.tiles.set(keyOf(tx, ty), { tx, ty, canvas, blob: null, dirty: false, v: 0 });
              }
            }
          }
          bitmap.close?.();
        }
        await Promise.all([...this.tiles.values()].map(async t => {
          if (t.canvas || !t.blob) return;
          const blob = t.blob;
          const entry = await shareDecoded(blob, urgent);
          if (!t.canvas && t.blob === blob && this.tiles.get(keyOf(t.tx, t.ty)) === t) {
            t.canvas = entry.canvas;
            t.shared = entry;
          } else {
            unuse(entry);
          }
        }));
        this._loading = null;
        if (!this.resident) this._becomeResident();
        invalidate();
        return true;
      })().catch(err => {
        this._loading = null;
        throw err;
      });
    }
    return this._loading;
  }

  markDirty() {
    this.dirty = true;
    this.version++;
  }

  // a tile's pixels changed. The first edit of a legacy frame turns it
  // into plain tiles (all of them need encoding then).
  _tileChanged(t) {
    if (this.legacy) {
      this.legacy = null;
      for (const other of this.tiles.values()) other.dirty = true;
    }
    t.dirty = true;
    t.v++;
    this.markDirty();
  }

  tileAt(tx, ty, create = false) {
    const k = keyOf(tx, ty);
    let t = this.tiles.get(k);
    if (!t && create) {
      t = { tx, ty, canvas: newTileCanvas(), shared: null, blob: null, dirty: true, v: 0 };
      this.tiles.set(k, t);
      scheduleEnforce();
    }
    return t ?? null;
  }

  // the (resident) frame's tiles touching rect, created where missing if asked
  tilesIn(rect, create = false) {
    const out = [];
    const { tx0, ty0, tx1, ty1 } = tileRange(rect);
    if (!create) {
      for (const t of this.tiles.values()) {
        if (t.tx >= tx0 && t.tx <= tx1 && t.ty >= ty0 && t.ty <= ty1) out.push(t);
      }
      return out;
    }
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) out.push(this.tileAt(tx, ty, true));
    }
    return out;
  }

  // draws on every tile touching rect (layer pixels): fn(ctx, ox, oy) gets
  // a context in document units, and the tile's top-left in layer pixels.
  // create: false doesn't add tiles (erasing empty space changes nothing).
  drawWith(rect, fn, { create = true } = {}) {
    if (!this.ensureResident()) return false;
    const dpr = this.owner.dpr;
    for (const t of this.tilesIn(rect, create)) {
      own(t);
      const ox = t.tx * TILE;
      const oy = t.ty * TILE;
      const ctx = t.canvas.getContext('2d');
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, -ox, -oy);
      fn(ctx, ox, oy);
      ctx.restore();
      this._tileChanged(t);
    }
    invalidate();
    return true;
  }

  // a copy of the pixels over rect (layer pixels) — the caller releases it
  readRegion(rect) {
    const c = document.createElement('canvas');
    c.width = rect.w;
    c.height = rect.h;
    const ctx = c.getContext('2d');
    for (const t of this.tilesIn(rect)) {
      if (t.canvas) ctx.drawImage(t.canvas, t.tx * TILE - rect.x, t.ty * TILE - rect.y);
    }
    return c;
  }

  // replaces the pixels over rect with src's (src's sx,sy at rect's corner)
  writeRegion(rect, src, sx = 0, sy = 0) {
    if (!this.ensureResident()) return;
    for (const t of this.tilesIn(rect, true)) {
      const cell = { x: t.tx * TILE, y: t.ty * TILE, w: TILE, h: TILE };
      const r = intersectRect(cell, rect);
      if (!r) continue;
      own(t);
      const ctx = t.canvas.getContext('2d');
      ctx.clearRect(r.x - cell.x, r.y - cell.y, r.w, r.h);
      ctx.drawImage(src, sx + r.x - rect.x, sy + r.y - rect.y, r.w, r.h, r.x - cell.x, r.y - cell.y, r.w, r.h);
      this._tileChanged(t);
    }
    invalidate();
  }

  // the pixel area the frame has tiles over (layer pixels), or null
  bounds() {
    if (this.legacy && this.tiles.size === 0) return { ...this.legacy.extent };
    let b = null;
    for (const t of this.tiles.values()) {
      const x = t.tx * TILE;
      const y = t.ty * TILE;
      if (!b) b = { x0: x, y0: y, x1: x + TILE, y1: y + TILE };
      else {
        b.x0 = Math.min(b.x0, x);
        b.y0 = Math.min(b.y0, y);
        b.x1 = Math.max(b.x1, x + TILE);
        b.y1 = Math.max(b.y1, y + TILE);
      }
    }
    return b && { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
  }

  // for undo: a copy of one tile, or null if it doesn't exist
  snapshotTile(tx, ty) {
    const t = this.tiles.get(keyOf(tx, ty));
    if (!t?.canvas) return { tx, ty, canvas: null };
    const c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    c.getContext('2d').drawImage(t.canvas, 0, 0);
    return { tx, ty, canvas: c };
  }

  // puts a snapshotTile() back (null: no tile there)
  restoreTile(snap) {
    invalidate();
    if (!snap.canvas) {
      const k = keyOf(snap.tx, snap.ty);
      const t = this.tiles.get(k);
      if (t) {
        dropCanvas(t);
        this.tiles.delete(k);
        if (this.legacy) this._tileChanged({ v: 0 }); // the legacy image no longer matches
        else this.markDirty();
      }
      return;
    }
    const t = this.tileAt(snap.tx, snap.ty, true);
    own(t);
    const ctx = t.canvas.getContext('2d');
    ctx.clearRect(0, 0, TILE, TILE);
    ctx.drawImage(snap.canvas, 0, 0);
    this._tileChanged(t);
  }

  clearAll() {
    for (const t of this.tiles.values()) dropCanvas(t);
    this.tiles.clear();
    this.legacy = null;
    this.markDirty();
    invalidate();
  }

  // encodes changed tiles; tiles that came out fully transparent are dropped.
  // One at a time per frame (autosave and eviction both call this) — two
  // passes over the same tiles would trip over each other's deletions.
  async encode() {
    while (this._encoding) await this._encoding;
    if (!this.dirty) return;
    this._encoding = this._encodeOnce();
    try {
      await this._encoding;
    } finally {
      this._encoding = null;
    }
  }

  async _encodeOnce() {
    const version = this.version;
    const jobs = [];
    for (const [k, t] of [...this.tiles]) {
      if (!t.dirty || !t.canvas) continue;
      if (isTransparent(t.canvas)) {
        dropCanvas(t);
        this.tiles.delete(k);
        continue;
      }
      // all of a frame's tiles at once — the browser encodes in parallel
      const v = t.v;
      // borders are line art on transparency — never JPEG, even on a video layer
      jobs.push(encodeCanvas(t.canvas, this.isGuide ? 'png' : this.owner.encoding).then(blob => {
        // drawn on again meanwhile: this blob is already stale
        if (t.v === v) {
          t.blob = blob;
          t.dirty = false;
        }
      }));
    }
    await Promise.all(jobs);
    // edited again while encoding — stays dirty
    if (this.version === version) this.dirty = false;
  }

  // what gets saved: { blob, extent } for an untouched legacy image,
  // otherwise { tiles: [{ x, y, blob }] }
  // guide: the fill borders' tiles, if any
  async serialize() {
    await this.encode();
    let guide = null;
    if (this.guide && !this.guide.isBlank) guide = (await this.guide.serialize()).tiles;
    if (this.legacy) return { blob: this.legacy.blob, extent: { ...this.legacy.extent }, guide };
    const tiles = [];
    for (const t of this.tiles.values()) if (t.blob) tiles.push({ x: t.tx, y: t.ty, blob: t.blob });
    return { tiles, guide };
  }

  isKept() {
    return this.pins > 0 || (this.attached && keepProvider().includes(this));
  }

  async evict() {
    if (!this.resident || this._evicting) return;
    this._evicting = true;
    try {
      await this.encode();
      if (this.dirty || this.isKept()) return;
      this._drop();
    } catch (e) {
      console.error('Не удалось выгрузить кадр', e);
    } finally {
      this._evicting = false;
    }
  }

  _drop() {
    for (const t of this.tiles.values()) dropCanvas(t);
    // tiles cut from a legacy image are just that image again
    if (this.legacy) this.tiles.clear();
    this.resident = false;
    resident.delete(this);
  }

  // left its layer (frame deleted, insert undone) — it may come back via
  // undo/redo, so keep the pixels, just not decoded
  detach() {
    this.attached = false;
    this.evict();
    this.guide?.detach();
  }

  attach() {
    this.attached = true;
    this.guide?.attach();
  }

  // the whole layer is gone — nothing can bring this frame back
  release() {
    this.attached = false;
    this._drop();
    this.tiles.clear();
    this.guide?.release();
  }
}

// read-only access to what a frame shows inside the camera (export,
// thumbnails), without making it resident: a canvas of the camera area,
// thumbSize (number: square; { width, height }) or full size. The caller
// must release() it. null for a blank frame.
export async function readFrameImage(frame, thumbSize = null) {
  if (frame.isBlank) return null;
  const { pixelWidth: pw, pixelHeight: ph } = frame.owner;
  let w = pw;
  let h = ph;
  if (thumbSize) {
    w = typeof thumbSize === 'number' ? thumbSize : thumbSize.width;
    h = typeof thumbSize === 'number' ? thumbSize : thumbSize.height;
  }
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d');
  const kx = c.width / pw;
  const ky = c.height / ph;
  ctx.setTransform(kx, 0, 0, ky, 0, 0);
  const camera = { x: 0, y: 0, w: pw, h: ph };
  frame.pins++;
  try {
    if (frame.legacy && frame.tiles.size === 0) {
      const e = frame.legacy.extent;
      const bitmap = await decodeBlob(frame.legacy.blob, thumbSize ? { width: Math.max(1, Math.round(e.w * kx)), height: Math.max(1, Math.round(e.h * ky)) } : null);
      ctx.drawImage(bitmap, e.x, e.y, e.w, e.h);
      bitmap.close?.();
    } else {
      const size = thumbSize ? { width: Math.max(1, Math.round(TILE * kx)), height: Math.max(1, Math.round(TILE * ky)) } : null;
      for (const t of frame.tilesIn(camera)) {
        if (t.canvas) {
          ctx.drawImage(t.canvas, t.tx * TILE, t.ty * TILE);
        } else if (t.blob) {
          const bitmap = await decodeBlob(t.blob, size);
          ctx.drawImage(bitmap, t.tx * TILE, t.ty * TILE, TILE, TILE);
          bitmap.close?.();
        }
      }
    }
  } finally {
    frame.pins--;
  }
  return { image: c, rect: { x: 0, y: 0, w: 1, h: 1 }, release: () => releaseCanvas(c) };
}

// draws what readFrameImage() returned onto ctx, whose 0,0 – width,height
// is the camera
// tint: every line in this one color (a layer's color, thumbnails)
export function drawFrameImage(ctx, src, width, height, tint = null) {
  const r = src.rect;
  if (!tint) {
    ctx.drawImage(src.image, r.x * width, r.y * height, r.w * width, r.h * height);
    return;
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const cctx = c.getContext('2d');
  cctx.drawImage(src.image, r.x * width, r.y * height, r.w * width, r.h * height);
  cctx.globalCompositeOperation = 'source-in';
  cctx.fillStyle = tint;
  cctx.fillRect(0, 0, width, height);
  ctx.drawImage(c, 0, 0);
  c.width = c.height = 0;
}

function scheduleEnforce() {
  if (enforceScheduled) return;
  enforceScheduled = true;
  setTimeout(enforceBudget, 0);
}

async function enforceBudget() {
  enforceScheduled = false;
  if (enforcing) {
    enforceAgain = true;
    return;
  }
  enforcing = true;
  try {
    if (residentBytes() <= MEMORY_BUDGET_BYTES) return;
    const candidates = [...resident].filter(f => !f.isKept()).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const f of candidates) {
      // (a frame whose pictures other frames share frees less, or nothing)
      if (residentBytes() <= MEMORY_BUDGET_BYTES) break;
      await f.evict();
    }
  } finally {
    enforcing = false;
    if (enforceAgain) {
      enforceAgain = false;
      scheduleEnforce();
    }
  }
}

// for tests/diagnostics
export function residentStats() {
  return { frames: resident.size, bytes: residentBytes(), shared: sharedTiles.size };
}
