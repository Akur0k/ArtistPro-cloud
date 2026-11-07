// Lasso outline and the lifted fragment, drawn on a screen-sized canvas over
// the picture (see Display.js) in document coordinates under the current
// view. It's a plain picture: whoever drew it redraws it after the view
// moves (main.js: redrawOverlay).
import { drawWarped } from './Warp.js';

export class SelectionOverlay {
  constructor(display) {
    this.display = display;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'selection-overlay';
    display.wrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    // the lifted piece's layer color, if it has one (set by whoever draws)
    this.tint = null;
    this._tinted = new WeakMap(); // piece canvas -> { tint, canvas }
    this.resize();
  }

  resize() {
    const d = this.display;
    if (this.canvas.width !== d.canvas.width || this.canvas.height !== d.canvas.height) {
      this.canvas.width = d.canvas.width;
      this.canvas.height = d.canvas.height;
    }
    this.canvas.style.width = `${d.cssWidth}px`;
    this.canvas.style.height = `${d.cssHeight}px`;
  }

  clear() {
    this.resize();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.display.applyDocTransform(this.ctx);
  }

  // dark: the dash color under the white one (red for a cut-out outline)
  strokeDashedPath(points, closed, dark = '#000') {
    if (points.length < 2) return;
    const ctx = this.ctx;
    const k = 1 / this.display.view.scale; // screen pixels → document units
    ctx.save();
    ctx.lineWidth = 1.5 * k;
    ctx.setLineDash([6 * k, 4 * k]);

    ctx.strokeStyle = dark;
    ctx.lineDashOffset = 0;
    this._tracePath(points, closed);
    ctx.stroke();

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 6 * k;
    this._tracePath(points, closed);
    ctx.stroke();

    ctx.restore();
  }

  // a thick translucent line through points (a tween's path), width in
  // screen pixels
  strokeBand(points, color, width) {
    if (points.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = width / this.display.view.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    this._tracePath(points, false);
    ctx.stroke();
    ctx.restore();
  }

  // a round marker of radius r screen pixels
  dot(x, y, r, fill, stroke = null) {
    const ctx = this.ctx;
    const k = 1 / this.display.view.scale;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r * k, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = 2 * k;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    ctx.restore();
  }

  // a light tint over the selected area (loops: outer outlines and holes)
  fillLoops(loops, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    for (const pts of loops) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    }
    ctx.fillStyle = color;
    ctx.fill('evenodd');
    ctx.restore();
  }

  _tracePath(points, closed) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (closed) ctx.closePath();
  }

  drawFragmentTransformed(fragCanvas, cx, cy, w, h, scale, rotation, alpha = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);
    ctx.drawImage(this._tintedCopy(fragCanvas), -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // the piece pulled onto a four-cornered shape (quad: TL, TR, BR, BL).
  // Made once per shape into a picture of its own, about as sharp as the
  // screen shows it (steps of ×2), and only that picture is drawn here —
  // moving / zooming the view never rebuilds it, only a new shape does
  drawFragmentWarped(fragCanvas, quad, alpha = 1) {
    const ctx = this.ctx;
    const t = ctx.getTransform();
    const k = Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)); // document unit → device pixels
    const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
    const bx = Math.min(...xs), by = Math.min(...ys);
    const bw = Math.max(...xs) - bx || 1, bh = Math.max(...ys) - by || 1;
    const d = Math.min(2 ** Math.ceil(Math.log2(k)), 2048 / Math.max(bw, bh));
    const src = this._tintedCopy(fragCanvas);
    const key = `${quad.map(p => `${p.x},${p.y}`).join(';')}|${d}`;
    let w = this._warped;
    if (!w || w.src !== src || w.key !== key) {
      const c = w?.canvas ?? document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(bw * d));
      c.height = Math.max(1, Math.ceil(bh * d));
      const cx = c.getContext('2d');
      cx.setTransform(d, 0, 0, d, -bx * d, -by * d);
      let side = 0;
      for (let i = 0; i < 4; i++) side = Math.max(side, Math.hypot(xs[(i + 1) % 4] - xs[i], ys[(i + 1) % 4] - ys[i]) * d);
      drawWarped(cx, this._previewCopy(src, side), quad);
      w = this._warped = { src, key, canvas: c };
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(w.canvas, bx, by, w.canvas.width / d, w.canvas.height / d);
    ctx.restore();
  }

  // the transform is over: its picture can go
  dropWarped() {
    this._warped = null;
  }

  // the canvas at about `side` device pixels on its longer side: one of
  // its halvings (½, ¼, …), each made once from the one before and kept —
  // zooming back and forth past a step never makes a new one again
  _previewCopy(canvas, side) {
    let levels = this._small?.get(canvas);
    if (!levels) {
      levels = [canvas];
      (this._small ??= new WeakMap()).set(canvas, levels);
    }
    let i = 0;
    for (;;) {
      const cur = levels[i];
      const longer = Math.max(cur.width, cur.height);
      if (longer / 2 < side || longer / 2 < 64) return cur;
      if (!levels[i + 1]) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(cur.width / 2));
        c.height = Math.max(1, Math.round(cur.height / 2));
        c.getContext('2d').drawImage(cur, 0, 0, c.width, c.height);
        levels.push(c);
      }
      i++;
    }
  }

  // the piece in its layer's color (made once per piece and color)
  _tintedCopy(canvas) {
    if (!this.tint) return canvas;
    const hit = this._tinted.get(canvas);
    if (hit?.tint === this.tint) return hit.canvas;
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = this.tint;
    ctx.fillRect(0, 0, c.width, c.height);
    this._tinted.set(canvas, { tint: this.tint, canvas: c });
    return c;
  }
}
