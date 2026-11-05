import { Frame, invalidateDisplay } from './Frame.js';

let nextId = 1;

const MAX_BACKING_DIMENSION = 2048;
const MAX_DPR = 2;
// frames decoded ahead of the playhead during playback, so playing back
// encoded frames doesn't stutter waiting on each decode
const PLAYBACK_LOOKAHEAD = 4;

// pixel ratio and the camera's size in pixels for a document of
// cssWidth × cssHeight. Depends on the document only (not the device), so
// saved tiles mean the same thing everywhere.
export function backingFor(cssWidth, cssHeight) {
  const dpr = Math.max(1, Math.min(MAX_DPR, MAX_BACKING_DIMENSION / cssWidth, MAX_BACKING_DIMENSION / cssHeight));
  return {
    dpr,
    pixelWidth: Math.max(1, Math.round(cssWidth * dpr)),
    pixelHeight: Math.max(1, Math.round(cssHeight * dpr)),
  };
}

export class Layer {
  // encoding: how this layer's frames are stored — 'png' (keeps
  // transparency, drawn layers) or 'jpeg' (much smaller, for opaque
  // photographic content like imported video)
  constructor(cssWidth, cssHeight, name = `Слой ${nextId}`, { encoding = 'png' } = {}) {
    this.id = nextId++;
    this.name = name;
    this.visible = true;
    this.opacity = 1;
    // a color the layer is shown in on screen (every line in it, whatever
    // its own color) — the drawing itself keeps its colors, and exports
    // show those. null: its own colors
    this.tint = null;
    this.encoding = encoding;

    const backing = backingFor(cssWidth, cssHeight);
    this.dpr = backing.dpr;
    // the camera: what export / thumbnails show
    this.pixelWidth = backing.pixelWidth;
    this.pixelHeight = backing.pixelHeight;

    // the frame the screen shows for this layer: the current one once it's
    // decoded — until then the one shown before (no flash of empty canvas
    // between frames during playback)
    this.shownFrame = null;

    // called with (layer, frame) once an encoded frame finished decoding
    this.onFrameReady = null;

    this.frames = [new Frame(this)];
    // the tick its first frame starts at — before it the layer is empty
    // (a movement made later in the animation starts there)
    this.start = 0;
    this.currentFrameIndex = 0;
    this.ended = false; // the playhead is past this layer's last frame
  }

  get frameCount() {
    return this.frames.length;
  }

  // the tick its last frame ends at
  get totalDuration() {
    return this.frames.reduce((sum, f) => sum + f.duration, this.start);
  }

  get currentFrame() {
    return this.frames[this.currentFrameIndex];
  }

  frameDurationAt(index) {
    return this.frames[index]?.duration ?? 1;
  }

  setFrameDuration(index, duration) {
    if (!this.frames[index]) return;
    this.frames[index].duration = Math.max(1, Math.round(duration));
  }

  // this layer's frame at a global time position (ticks), or -1 once its
  // frames are over — a layer doesn't repeat; past its last frame it's
  // simply empty (the whole animation loops at the longest layer's end)
  frameIndexAtTime(t) {
    if (t < this.start) return -1;
    let local = t - this.start;
    for (let i = 0; i < this.frames.length; i++) {
      if (local < this.frames[i].duration) return i;
      local -= this.frames[i].duration;
    }
    return -1;
  }

  // shows the frame at time t — or nothing, past the layer's end (`ended`:
  // the current frame stays the last one, for the panels, but isn't shown)
  syncToTime(t) {
    const idx = this.frameIndexAtTime(t);
    if (idx < 0) {
      // (before its start: its first frame)
      this.currentFrameIndex = t < this.start ? 0 : this.frames.length - 1;
      this.ended = true;
      this.shownFrame = null;
      invalidateDisplay();
      return;
    }
    this.setActiveFrame(idx);
  }

  setActiveFrame(index) {
    this.currentFrameIndex = Math.max(0, Math.min(index, this.frames.length - 1));
    this.ended = false;
    this._syncDisplay();
  }

  _syncDisplay() {
    const frame = this.currentFrame;
    // its fill borders show on screen too
    if (frame.guide && !frame.guide.resident) frame.guide.load(true).catch(() => {});
    if (frame.ensureResident()) {
      this.shownFrame = frame;
      invalidateDisplay();
      return;
    }
    frame.load(true).then(() => {
      if (this.currentFrame !== frame) return;
      this.shownFrame = frame;
      invalidateDisplay();
      this.onFrameReady?.(this, frame);
    }, e => console.error('Не удалось загрузить кадр', e));
  }

  // frames that must stay decoded: the current one, while playing the next
  // few, and with onion skin on its neighbours
  keepFrames(playing, onion = false) {
    const i = this.currentFrameIndex;
    const n = this.frames.length;
    const ahead = playing ? PLAYBACK_LOOKAHEAD : onion ? 1 : 0;
    const keep = [];
    if (onion && i > 0) keep.push(this.frames[i - 1]);
    for (let k = 0; k <= ahead && k < n; k++) keep.push(this.frames[(i + k) % n]);
    return keep;
  }

  prefetch(playing, onion = false) {
    for (const frame of this.keepFrames(playing, onion)) {
      if (frame.resident || frame.isBlank || frame === this.currentFrame) continue;
      frame.load().then(() => this.onFrameReady?.(this, frame), () => {});
    }
  }

  insertFrame(index, duration = 1) {
    const frame = new Frame(this, duration);
    this.frames.splice(index, 0, frame);
    return frame;
  }

  // puts back a frame object that was removed earlier (undo/redo) or built
  // elsewhere (tween, video import)
  insertFrameObject(index, frame) {
    frame.attach();
    this.frames.splice(index, 0, frame);
    this._syncDisplay();
  }

  // laid out anew: the first frame at `start`, then `frames` (frame objects
  // — some already its own, some new); frames that left are detached
  setLayout(start, frames) {
    const keep = new Set(frames);
    for (const f of this.frames) if (!keep.has(f)) f.detach();
    const had = new Set(this.frames);
    for (const f of frames) if (!had.has(f)) f.attach();
    this.start = start;
    this.frames = frames;
  }

  replaceFrames(frames) {
    for (const f of this.frames) f.release();
    this.frames = frames;
    this.currentFrameIndex = 0;
    this._syncDisplay();
  }

  moveFrame(fromIndex, toIndex) {
    if (fromIndex === toIndex || !this.frames[fromIndex]) return;
    const [frame] = this.frames.splice(fromIndex, 1);
    this.frames.splice(toIndex, 0, frame);

    // keep pointing at the same physical frame, since its array position moved
    if (this.currentFrameIndex === fromIndex) {
      this.currentFrameIndex = toIndex;
    } else if (fromIndex < this.currentFrameIndex && toIndex >= this.currentFrameIndex) {
      this.currentFrameIndex -= 1;
    } else if (fromIndex > this.currentFrameIndex && toIndex <= this.currentFrameIndex) {
      this.currentFrameIndex += 1;
    }
  }

  // returns the removed frame object (history keeps it for undo)
  removeFrame(index) {
    if (this.frames.length <= 1) return null;
    const [frame] = this.frames.splice(index, 1);
    if (this.currentFrameIndex >= this.frames.length) {
      this.currentFrameIndex = this.frames.length - 1;
    }
    frame.detach();
    this._syncDisplay();
    return frame;
  }

  clear() {
    this.currentFrame.clearAll();
  }

  release() {
    for (const f of this.frames) f.release();
  }

  // visibility / opacity changed
  applyVisualState() {
    invalidateDisplay();
  }
}
