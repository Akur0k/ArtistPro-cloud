// A layer that is one moving picture (an "object"), not frames: it keeps
// the picture once and its key poses — { t (tick), x, y (its centre,
// document units), scale, rotation (radians), ease (how it moves on to
// the next key, see Easing.js) }. Every moment between two keys is worked
// out when it's shown or exported; nothing is drawn ahead.
//
// It's there from its first key to its last (its span); outside of it
// the layer shows nothing (`ended`), like a frame layer past its end.

import { Layer } from './Layer.js';
import { invalidateDisplay } from './Frame.js';
import { EASING_FNS } from './Easing.js';

const lerp = (a, b, u) => a + (b - a) * u;

export class ObjectLayer extends Layer {
  // piece: { canvas | null, blob, w, h } — w, h: its size in document
  // units (the picture may have any resolution)
  constructor(cssWidth, cssHeight, name, { piece, keys }) {
    super(cssWidth, cssHeight, name);
    for (const f of this.frames) f.release();
    this.frames = [];
    this.kind = 'object';
    this.docWidth = cssWidth;
    this.docHeight = cssHeight;
    this.piece = piece;
    this.keys = keys.map(k => ({ ...k })).sort((a, b) => a.t - b.t);
    this.time = 0;
    // while a finger moves it: the pose shown at the current tick instead
    this.livePose = null;
    this._decoding = null;
  }

  get frameCount() {
    return 0;
  }

  get currentFrame() {
    return null;
  }

  // the tick after its last key
  get totalDuration() {
    return this.keys.length ? this.keys[this.keys.length - 1].t + 1 : 1;
  }

  get firstTick() {
    return this.keys[0]?.t ?? 0;
  }

  inSpan(t) {
    return this.keys.length > 0 && t >= this.firstTick && t <= this.keys[this.keys.length - 1].t;
  }

  keyAt(t) {
    return this.keys.find(k => k.t === t) ?? null;
  }

  // where it is at tick t (before its first key: there, after its last: there)
  poseAt(t) {
    if (this.livePose && t === this.time) return this.livePose;
    const ks = this.keys;
    if (!ks.length) return { x: this.docWidth / 2, y: this.docHeight / 2, scale: 1, rotation: 0 };
    if (t <= ks[0].t) return ks[0];
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i];
      const b = ks[i + 1];
      if (t < b.t) {
        const u = (EASING_FNS[a.ease] || EASING_FNS.linear)((t - a.t) / (b.t - a.t));
        return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), scale: lerp(a.scale, b.scale, u), rotation: lerp(a.rotation, b.rotation, u) };
      }
    }
    return ks[ks.length - 1];
  }

  // the picture, ready to draw (decoded from its blob after opening)
  ready() {
    if (this.piece.canvas) return Promise.resolve();
    if (!this._decoding) {
      this._decoding = createImageBitmap(this.piece.blob).then(bm => {
        this.piece.canvas = bm;
        invalidateDisplay();
      });
    }
    return this._decoding;
  }

  // draws it at tick t on ctx, which draws in document units
  drawAt(ctx, t) {
    if (!this.piece.canvas) {
      this.ready().catch(() => {});
      return;
    }
    const p = this.poseAt(t);
    const { w, h } = this.piece;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);
    ctx.scale(p.scale, p.scale);
    ctx.drawImage(this.piece.canvas, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // is document point d on it at tick t (pad: document units around it)
  hit(d, t, pad = 0) {
    const p = this.poseAt(t);
    const dx = d.x - p.x;
    const dy = d.y - p.y;
    const c = Math.cos(-p.rotation);
    const s = Math.sin(-p.rotation);
    const lx = (dx * c - dy * s) / p.scale;
    const ly = (dx * s + dy * c) / p.scale;
    const m = pad / p.scale;
    return Math.abs(lx) <= this.piece.w / 2 + m && Math.abs(ly) <= this.piece.h / 2 + m;
  }

  // the corners of its box at tick t (document units)
  outlineAt(t) {
    const p = this.poseAt(t);
    const c = Math.cos(p.rotation) * p.scale;
    const s = Math.sin(p.rotation) * p.scale;
    const w = this.piece.w / 2;
    const h = this.piece.h / 2;
    return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => ({ x: p.x + x * c - y * s, y: p.y + x * s + y * c }));
  }

  frameIndexAtTime() {
    return -1;
  }

  syncToTime(t) {
    this.time = t;
    this.ended = !this.inSpan(t);
    invalidateDisplay();
  }

  setActiveFrame() {}

  keepFrames() {
    return [];
  }

  prefetch() {}

  clear() {}

  release() {
    this.piece.canvas?.close?.();
  }
}
