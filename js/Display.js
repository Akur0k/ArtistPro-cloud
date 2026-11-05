// The editor's picture: one canvas the size of the canvas area, redrawn
// (at most once per animation frame, when something changed) from the
// layers' tiles under the current view.
//
// Nothing document-sized lives in the page: on iOS, Safari backs big
// canvases inside a zoomed element with memory proportional to their size
// on screen, and with an unbounded drawing area that ran the phone out of
// memory while zooming. Here the cost is the screen, whatever the zoom.

import { TILE, setInvalidate } from './Frame.js';
import { drawImageCover } from './LayerManager.js';

const OUTSIDE_VEIL = 'rgba(20, 20, 20, 0.45)';
// onion skin: the previous frame in blue, the next one in red — each drawn
// as a flat tint of its shapes, so it reads as a guide, not as artwork
const ONION = [
  { delta: -1, color: '#2563eb', alpha: 0.4 },
  { delta: 1, color: '#e11d48', alpha: 0.35 },
];

export class Display {
  // view: ViewTransform; getOnion(): onion skin on (and not playing);
  // getGuides(): fill borders shown
  constructor({ wrap, layerManager, view, docWidth, docHeight, getOnion, getGuides }) {
    this.wrap = wrap;
    this.layerManager = layerManager;
    this.view = view;
    this.docWidth = docWidth;
    this.docHeight = docHeight;
    this.getOnion = getOnion;
    this.getGuides = getGuides;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'display-canvas';
    wrap.insertBefore(this.canvas, wrap.firstChild);
    this.ctx = this.canvas.getContext('2d');
    // a translucent layer is drawn here first, then blended at its opacity
    // (drawn tile by tile straight onto the picture, the slight overlap
    // that hides the seams between tiles would show as lines)
    this.scratch = document.createElement('canvas');
    this.sctx = this.scratch.getContext('2d');

    this.pixelRatio = 1;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this._raf = 0;
    setInvalidate(() => this.invalidate());
    this.resize();
  }

  resize() {
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    const pr = Math.min(window.devicePixelRatio || 1, 3);
    if (w === this.cssWidth && h === this.cssHeight && pr === this.pixelRatio) return false;
    this.cssWidth = w;
    this.cssHeight = h;
    this.pixelRatio = pr;
    this.canvas.width = Math.max(1, Math.round(w * pr));
    this.canvas.height = Math.max(1, Math.round(h * pr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.scratch.width = this.canvas.width;
    this.scratch.height = this.canvas.height;
    this.renderNow();
    return true;
  }

  invalidate() {
    if (!this._raf) this._raf = requestAnimationFrame(() => this.renderNow());
  }

  // ctx draws in document units under the current view (same mapping as
  // ViewTransform.documentToScreen, relative to this canvas)
  applyDocTransform(ctx) {
    const v = this.view;
    const pr = this.pixelRatio;
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.translate(this.cssWidth / 2 + v.panX, this.cssHeight / 2 + v.panY);
    ctx.rotate(v.rotation);
    ctx.scale(v.scale, v.scale);
    ctx.translate(-this.docWidth / 2, -this.docHeight / 2);
  }

  // the document-space box the screen shows
  visibleDocRect() {
    const v = this.view;
    const cos = Math.cos(-v.rotation);
    const sin = Math.sin(-v.rotation);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[0, 0], [this.cssWidth, 0], [0, this.cssHeight], [this.cssWidth, this.cssHeight]]) {
      const vx = sx - this.cssWidth / 2 - v.panX;
      const vy = sy - this.cssHeight / 2 - v.panY;
      const x = (vx * cos - vy * sin) / v.scale + this.docWidth / 2;
      const y = (vx * sin + vy * cos) / v.scale + this.docHeight / 2;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1 };
  }

  // a frame's tiles inside the visible box (document units vis)
  _drawFrame(ctx, layer, frame, vis) {
    const dpr = layer.dpr;
    const t0x = Math.floor((vis.x0 * dpr) / TILE);
    const t0y = Math.floor((vis.y0 * dpr) / TILE);
    const t1x = Math.floor((vis.x1 * dpr) / TILE);
    const t1y = Math.floor((vis.y1 * dpr) / TILE);
    const size = TILE / dpr;
    // overlap each tile half a screen pixel into the next: drawn scaled,
    // tile edges would otherwise leave hairline gaps
    const pad = 0.5 / this.view.scale;
    for (const t of frame.tiles.values()) {
      if (!t.canvas || t.tx < t0x || t.tx > t1x || t.ty < t0y || t.ty > t1y) continue;
      ctx.drawImage(t.canvas, t.tx * size, t.ty * size, size + pad, size + pad);
    }
  }

  // tint: draw the frame's shapes in this one color (onion skin)
  _drawLayer(ctx, layer, frame, vis, alpha, tint = null) {
    if (!frame?.resident) return;
    // a video layer is JPEG: no transparency, black past the camera
    this._paint(ctx, alpha, tint, layer.encoding === 'jpeg', c => this._drawFrame(c, layer, frame, vis));
  }

  // an object layer at its tick — outside its span only while it's the
  // selected layer, faintly (so it can still be picked up and moved)
  _drawObject(ctx, layer, active, tint) {
    const alpha = layer.opacity * (layer.ended ? (active ? 0.3 : 0) : 1);
    if (alpha <= 0) return;
    this._paint(ctx, alpha, tint, false, c => layer.drawAt(c, layer.time));
  }

  // draw(c) draws in document units; alpha / tint / clip (to the camera)
  // applied to what it drew as a whole
  _paint(ctx, alpha, tint, clip, draw) {
    if (alpha >= 1 && !tint) {
      ctx.save();
      if (clip) {
        ctx.beginPath();
        ctx.rect(0, 0, this.docWidth, this.docHeight);
        ctx.clip();
      }
      draw(ctx);
      ctx.restore();
      return;
    }
    const s = this.sctx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, this.scratch.width, this.scratch.height);
    // save/restore: the camera clip must not stay on the scratch canvas
    // for the next layer (or its next clearRect)
    s.save();
    this.applyDocTransform(s);
    if (clip) {
      s.beginPath();
      s.rect(0, 0, this.docWidth, this.docHeight);
      s.clip();
    }
    draw(s);
    if (tint) {
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalCompositeOperation = 'source-in';
      s.fillStyle = tint;
      s.fillRect(0, 0, this.scratch.width, this.scratch.height);
    }
    s.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.scratch, 0, 0);
    ctx.restore();
  }

  renderNow() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    const ctx = this.ctx;
    const lm = this.layerManager;
    const { docWidth: dw, docHeight: dh } = this;

    // paper everywhere — the drawing area has no edge
    const paper = lm.backgroundMode === 'color' ? (lm.backgroundColor || '#ffffff') : '#ffffff';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.applyDocTransform(ctx);
    if (lm.backgroundMode === 'image' && lm.backgroundImageBitmap) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, dw, dh);
      ctx.clip();
      ctx.translate(0, 0);
      drawImageCover(ctx, lm.backgroundImageBitmap, dw, dh);
      ctx.restore();
    }

    const vis = this.visibleDocRect();

    for (const layer of lm.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      if (layer.kind === 'object') {
        this._drawObject(ctx, layer, layer === lm.activeLayer, lm.tintOf(layer));
        continue;
      }
      this._drawLayer(ctx, layer, layer.shownFrame, vis, layer.opacity, lm.tintOf(layer));
    }

    // onion skin: the selected layer's neighbouring frames only (with
    // every layer's, other layers looked see-through over each other) —
    // over every layer, so nothing above hides it
    const onionLayer = lm.activeLayer;
    if (this.getOnion?.() && onionLayer?.visible && !onionLayer.ended) {
      for (const { delta, color, alpha } of ONION) {
        const frame = onionLayer.frames[onionLayer.currentFrameIndex + delta];
        if (frame) this._drawLayer(ctx, onionLayer, frame, vis, alpha * onionLayer.opacity, color);
      }
    }

    // fill borders, over the picture (they're never exported)
    if (this.getGuides?.()) {
      for (const layer of lm.layers) {
        if (!layer.visible) continue;
        const g = layer.shownFrame?.guide;
        if (g?.resident) this._drawLayer(ctx, layer, g, vis, 0.9);
      }
    }

    // dim everything outside the camera: it's there, but not in the shot
    const m = Math.max(vis.x1 - vis.x0, vis.y1 - vis.y0);
    ctx.beginPath();
    ctx.rect(vis.x0 - m, vis.y0 - m, vis.x1 - vis.x0 + 2 * m, vis.y1 - vis.y0 + 2 * m);
    ctx.rect(0, 0, dw, dh);
    ctx.fillStyle = OUTSIDE_VEIL;
    ctx.fill('evenodd');
    ctx.lineWidth = 1 / this.view.scale;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeRect(0, 0, dw, dh);
  }
}
