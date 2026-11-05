// Placement step of the video / picture import: it's shown over the canvas
// and positioned with the same gestures as a lifted lasso selection — one
// finger moves it, two fingers scale and rotate it (mouse wheel scales,
// shift+wheel rotates). The result is a single transform applied to every
// imported frame.
//
// Placement is expressed in document space: the video's center (cx, cy),
// its unscaled size (w, h: the video fitted inside the document), plus
// scale and rotation on top of that.

import { centroid, distance, angle } from './GestureMath.js';
import { seekTo } from './VideoImport.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const PREVIEW_ALPHA = 0.85;
// the preview is a still copy of the current video frame, at most this big
// — copying a frame out of a <video> is slow on phones (especially 4K HEVC),
// so it's done once, never per gesture event
const PREVIEW_MAX_DIM = 1280;

// rotated rect's axis-aligned bounding box
function boundsOf(w, h, rotation) {
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  return { w: w * c + h * s, h: w * s + h * c };
}

// whether the placed video covers the whole document (then nothing of the
// layer stays transparent and its frames can be stored as JPEG)
export function coversDocument(p, docWidth, docHeight) {
  const cos = Math.cos(-p.rotation);
  const sin = Math.sin(-p.rotation);
  const hw = (p.w * p.scale) / 2 + 0.5;
  const hh = (p.h * p.scale) / 2 + 0.5;
  for (const [x, y] of [[0, 0], [docWidth, 0], [docWidth, docHeight], [0, docHeight]]) {
    const dx = x - p.cx;
    const dy = y - p.cy;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    if (Math.abs(lx) > hw || Math.abs(ly) > hh) return false;
  }
  return true;
}

// the placed rect's bounding box, document units
export function placedBounds(p) {
  const b = boundsOf(p.w * p.scale, p.h * p.scale, p.rotation);
  return { x0: p.cx - b.w / 2, y0: p.cy - b.h / 2, x1: p.cx + b.w / 2, y1: p.cy + b.h / 2 };
}

// draws the video with the placement onto ctx, whose pixels are k times
// document units; ox/oy: where the canvas's top-left is, in its pixels
// relative to the document origin
export function drawPlaced(ctx, source, p, k, ox = 0, oy = 0) {
  ctx.save();
  ctx.setTransform(k, 0, 0, k, -ox, -oy);
  ctx.translate(p.cx, p.cy);
  ctx.rotate(p.rotation);
  ctx.scale(p.scale, p.scale);
  // mirrored: flipX left-right, flipY top-bottom (in the picture's own frame)
  ctx.scale(p.flipX ? -1 : 1, p.flipY ? -1 : 1);
  ctx.drawImage(source, -p.w / 2, -p.h / 2, p.w, p.h);
  ctx.restore();
}

// resolves with the placement, or null if cancelled. source: a <video>
// (shown at `start` seconds) or any image drawImage() takes
// stage: the element that moves with the view (the preview goes in it);
// navigate(prev, cur): moves the view by a two-finger step (client points)
// — for two fingers put down outside the picture
export function placeVideo({ source, docWidth, docHeight, start = 0, initialFit = 'fill', stage, canvasWrap, appEl, toDoc, navigate = null }) {
  const isVideo = source instanceof HTMLVideoElement;
  const bar = document.getElementById('placeBar');
  const buttons = {
    rotate: document.getElementById('placeRotateBtn'),
    flipH: document.getElementById('placeFlipHBtn'),
    flipV: document.getElementById('placeFlipVBtn'),
    fill: document.getElementById('placeFillBtn'),
    fit: document.getElementById('placeFitBtn'),
    reset: document.getElementById('placeResetBtn'),
    cancel: document.getElementById('placeCancelBtn'),
    ok: document.getElementById('placeOkBtn'),
  };

  const vw = (isVideo ? source.videoWidth : source.naturalWidth || source.width) || docWidth;
  const vh = (isVideo ? source.videoHeight : source.naturalHeight || source.height) || docHeight;
  const base = Math.min(docWidth / vw, docHeight / vh);
  const p = { cx: docWidth / 2, cy: docHeight / 2, w: vw * base, h: vh * base, scale: 1, rotation: 0, flipX: false, flipY: false };
  let fitMode = 'fill'; // re-applied after a 90° turn; null once moved by hand

  function applyFit(mode) {
    p.cx = docWidth / 2;
    p.cy = docHeight / 2;
    if (mode === 'fit') {
      const b = boundsOf(p.w, p.h, p.rotation);
      p.scale = Math.min(docWidth / b.w, docHeight / b.h);
    } else {
      // the document rect, seen in the video's rotated frame, must fit inside it
      const b = boundsOf(docWidth, docHeight, -p.rotation);
      p.scale = Math.max(b.w / p.w, b.h / p.h);
    }
    fitMode = mode;
  }

  // the preview is a DOM element inside the layer stack (so it follows the
  // view's pan/zoom), moved with a CSS transform: gestures only touch a
  // style property, the GPU does the rest — no canvas redraw per event
  const pk = Math.min(1, PREVIEW_MAX_DIM / Math.max(vw, vh));
  const preview = document.createElement('canvas');
  preview.width = Math.max(1, Math.round(vw * pk));
  preview.height = Math.max(1, Math.round(vh * pk));
  const pctx = preview.getContext('2d');
  preview.style.cssText = `position:absolute;left:0;top:0;width:${p.w}px;height:${p.h}px;`
    + `transform-origin:center center;opacity:${PREVIEW_ALPHA};pointer-events:none;z-index:40;`
    // no CSS outline/shadow: WebKit re-rasterizes those at every new scale
    // during a pinch — the dashed frame is drawn into the bitmap instead,
    // so a gesture changes nothing but the compositor transform
    + 'will-change:transform;';
  stage.appendChild(preview);

  function capturePreview() {
    pctx.clearRect(0, 0, preview.width, preview.height);
    pctx.drawImage(source, 0, 0, preview.width, preview.height);
    const lw = Math.max(2, Math.round(Math.max(preview.width, preview.height) / 300));
    const dash = lw * 4;
    pctx.save();
    pctx.lineWidth = lw;
    pctx.setLineDash([dash, dash]);
    for (const [color, offset] of [['#000', 0], ['#fff', dash]]) {
      pctx.strokeStyle = color;
      pctx.lineDashOffset = offset;
      pctx.strokeRect(lw / 2, lw / 2, preview.width - lw, preview.height - lw);
    }
    pctx.restore();
  }

  let rafId = 0;
  function applyTransform() {
    rafId = 0;
    preview.style.transform = `translate3d(${p.cx - p.w / 2}px, ${p.cy - p.h / 2}px, 0) rotate(${p.rotation}rad) scale(${p.scale}) scale(${p.flipX ? -1 : 1}, ${p.flipY ? -1 : 1})`;
  }
  function draw() {
    if (!rafId) rafId = requestAnimationFrame(applyTransform);
  }

  applyFit(initialFit);

  // --- gestures ---
  // Each gesture is computed from where it started (not accumulated event
  // by event), in document space, and anchored at the fingers: the point of
  // the video under the fingers stays under them while pinching/rotating.
  const pointers = new Map(); // pointerId -> { x, y } client coords
  let gesture = null; // { base: {...p}, pts: [docPoint, docPoint?] }

  // whether a document point lies on the placed picture
  function onPicture(pt) {
    const dx = pt.x - p.cx;
    const dy = pt.y - p.cy;
    const cos = Math.cos(-p.rotation);
    const sin = Math.sin(-p.rotation);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return Math.abs(lx) <= (p.w * p.scale) / 2 && Math.abs(ly) <= (p.h * p.scale) / 2;
  }

  function restartGesture() {
    const client = [...pointers.values()].slice(0, 2);
    const pts = client.map(pt => toDoc(pt.x, pt.y));
    // two fingers both off the picture move the view instead
    if (navigate && pts.length === 2 && !pts.some(onPicture)) {
      gesture = { nav: true, prev: client.map(c => ({ ...c })) };
      return;
    }
    gesture = pts.length ? { base: { ...p }, pts } : null;
  }

  // within this of a multiple of 90°, rotation snaps straight
  const SNAP = (3 * Math.PI) / 180;
  function snapRotation(r) {
    const q = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
    return Math.abs(r - q) < SNAP ? q : r;
  }

  function updateGesture() {
    if (!gesture) return;
    if (gesture.nav) {
      const cur = [...pointers.values()].slice(0, 2).map(c => ({ ...c }));
      if (cur.length !== 2) return;
      navigate(gesture.prev, cur);
      gesture.prev = cur;
      return;
    }
    const cur = [...pointers.values()].slice(0, 2).map(pt => toDoc(pt.x, pt.y));
    if (cur.length !== gesture.pts.length) return;
    const { base, pts } = gesture;
    if (cur.length === 1) {
      p.cx = base.cx + (cur[0].x - pts[0].x);
      p.cy = base.cy + (cur[0].y - pts[0].y);
    } else {
      const [a0, b0] = pts;
      const [a1, b1] = cur;
      const d0 = distance(a0, b0);
      if (d0 < 1) return;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, base.scale * (distance(a1, b1) / d0)));
      const rotation = snapRotation(base.rotation + angle(a1, b1) - angle(a0, b0));
      const k = scale / base.scale;
      const dr = rotation - base.rotation;
      const c0 = centroid(a0, b0);
      const c1 = centroid(a1, b1);
      // video center relative to the fingers, scaled and turned with them
      const vx = base.cx - c0.x;
      const vy = base.cy - c0.y;
      const cos = Math.cos(dr);
      const sin = Math.sin(dr);
      p.cx = c1.x + (vx * cos - vy * sin) * k;
      p.cy = c1.y + (vx * sin + vy * cos) * k;
      p.scale = scale;
      p.rotation = rotation;
    }
    fitMode = null;
    draw();
  }

  const swallow = e => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  // the bar's own buttons/slider sit inside canvasWrap — leave those alone
  const onBar = e => bar.contains(e.target);

  function onDown(e) {
    if (onBar(e)) return;
    swallow(e);
    // first finger of a new touch: anything still listed is a finger whose
    // 'up' never arrived — it would otherwise hijack this gesture
    if (e.isPrimary) pointers.clear();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      canvasWrap.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone — the gesture still works without capture
    }
    restartGesture();
  }

  function onMove(e) {
    if (onBar(e) && !pointers.has(e.pointerId)) return;
    swallow(e);
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    updateGesture();
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    if (e.currentTarget === canvasWrap) swallow(e);
    pointers.delete(e.pointerId);
    // the remaining finger continues as a drag from where it is now
    restartGesture();
  }

  function onWheel(e) {
    if (onBar(e)) return;
    swallow(e);
    if (e.shiftKey) p.rotation += e.deltaY * 0.002;
    else p.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, p.scale * Math.exp(-e.deltaY * 0.001)));
    fitMode = null;
    draw();
  }

  // no 'pointerleave' here: as a capture listener it would also receive the
  // leave events of every element inside canvasWrap (a finger sliding off
  // the canvas onto the grey area) and drop a finger that's still down
  const listeners = [
    ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp],
    ['pointercancel', onUp], ['wheel', onWheel],
  ];
  for (const [ev, fn] of listeners) canvasWrap.addEventListener(ev, fn, { capture: true, passive: false });
  // a finger lifted somewhere the canvas area doesn't hear about still ends
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);

  appEl.classList.add('placing');
  bar.classList.add('show');
  capturePreview();
  draw();
  // show the clip's first frame (the element sits at time 0 until then)
  if (isVideo) seekTo(source, start).catch(() => {}).then(capturePreview);

  return new Promise(resolve => {
    const handlers = {
      rotate: () => {
        p.rotation = Math.round((p.rotation + Math.PI / 2) / (Math.PI / 2)) * (Math.PI / 2);
        if (fitMode) applyFit(fitMode);
        draw();
      },
      // mirror as it looks on screen, about its middle: a turned picture
      // mirrored = the picture mirrored in its own frame, turned the other way
      flipH: () => {
        p.flipX = !p.flipX;
        p.rotation = -p.rotation;
        draw();
      },
      flipV: () => {
        p.flipY = !p.flipY;
        p.rotation = -p.rotation;
        draw();
      },
      fill: () => { applyFit('fill'); draw(); },
      fit: () => { applyFit('fit'); draw(); },
      reset: () => {
        p.rotation = 0;
        p.flipX = false;
        p.flipY = false;
        applyFit(initialFit);
        draw();
      },
      cancel: () => finish(null),
      ok: () => finish({ ...p }),
    };
    for (const [k, fn] of Object.entries(handlers)) buttons[k].addEventListener('click', fn);

    function finish(result) {
      for (const [k, fn] of Object.entries(handlers)) buttons[k].removeEventListener('click', fn);
      for (const [ev, fn] of listeners) canvasWrap.removeEventListener(ev, fn, { capture: true });
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      cancelAnimationFrame(rafId);
      preview.remove();
      appEl.classList.remove('placing');
      bar.classList.remove('show');
      resolve(result);
    }
  });
}
