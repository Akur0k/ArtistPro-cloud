import { releaseCanvas } from './Frame.js';

// bigger lassos are refused rather than copied (a canvas this many pixels
// is already ~64 MB)
const MAX_FRAGMENT_PIXELS = 16_000_000;

export function pathBoundingBox(path) {
  let minX = path[0].x, maxX = path[0].x, minY = path[0].y, maxY = path[0].y;
  for (const p of path) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// the doc-space box in layer pixels
function boxToPixels(bboxDoc, dpr) {
  const x = Math.floor(bboxDoc.x * dpr);
  const y = Math.floor(bboxDoc.y * dpr);
  const w = Math.ceil((bboxDoc.x + bboxDoc.w) * dpr) - x;
  const h = Math.ceil((bboxDoc.y + bboxDoc.h) * dpr) - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function clipToPath(ctx, path) {
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
  ctx.closePath();
  ctx.clip();
}

// copies what's inside the path off the (resident) frame. The fragment's
// x/y are layer pixels relative to the camera (like the frame's tiles).
export function extractFragment(frame, path, dpr) {
  const bboxPx = boxToPixels(pathBoundingBox(path), dpr);
  if (!bboxPx || bboxPx.w * bboxPx.h > MAX_FRAGMENT_PIXELS) return null;

  const region = frame.readRegion(bboxPx);
  const frag = document.createElement('canvas');
  frag.width = bboxPx.w;
  frag.height = bboxPx.h;
  const fctx = frag.getContext('2d');
  fctx.setTransform(dpr, 0, 0, dpr, -bboxPx.x, -bboxPx.y);
  clipToPath(fctx, path);
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.drawImage(region, 0, 0);
  releaseCanvas(region);

  return { canvas: frag, x: bboxPx.x, y: bboxPx.y, w: bboxPx.w, h: bboxPx.h };
}

// ox/oy: where the canvas's top-left sits, in layer pixels
export function clearPathAreaOnContext(ctx, width, height, path, dpr, ox = 0, oy = 0) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, -ox, -oy);
  clipToPath(ctx, path);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.restore();
}

// the path's area in layer pixels (for undo), or null
export function pathRectPx(path, dpr) {
  const b = pathBoundingBox(path);
  return boxToPixels({ x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 }, dpr);
}

export function clearPathArea(frame, path, dpr) {
  const rect = pathRectPx(path, dpr);
  if (!rect) return;
  frame.drawWith(rect, (ctx, ox, oy) => {
    clearPathAreaOnContext(ctx, ctx.canvas.width, ctx.canvas.height, path, dpr, ox, oy);
  }, { create: false });
}

// A selection built from several outlines: regions [{ path, mode }] in
// document space, 'add' ones joined, 'sub' ones cut out of what came
// before. Its pixel area: the box around the added outlines (layer pixels).
export function regionsRectPx(regions, dpr) {
  const added = regions.filter(r => r.mode !== 'sub');
  if (!added.length) return null;
  let b = null;
  for (const { path } of added) {
    const p = pathBoundingBox(path);
    b = b
      ? { x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x + p.w), y1: Math.max(b.y1, p.y + p.h) }
      : { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
  }
  return boxToPixels({ x: b.x0 - 1, y: b.y0 - 1, w: b.x1 - b.x0 + 2, h: b.y1 - b.y0 + 2 }, dpr);
}

function fillPath(ctx, path) {
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
  ctx.closePath();
  ctx.fill();
}

// copies what's inside the selection off the (resident) frame. Returns
// { canvas, mask, x, y, w, h } — mask: the selection's shape over the same
// rect (what gets cut out of the frame) — or null if nothing's selected.
export function extractRegions(frame, regions, dpr) {
  const rect = regionsRectPx(regions, dpr);
  if (!rect || rect.w * rect.h > MAX_FRAGMENT_PIXELS) return null;

  const mask = document.createElement('canvas');
  mask.width = rect.w;
  mask.height = rect.h;
  const mctx = mask.getContext('2d');
  mctx.setTransform(dpr, 0, 0, dpr, -rect.x, -rect.y);
  mctx.fillStyle = '#000';
  for (const { path, mode } of regions) {
    mctx.globalCompositeOperation = mode === 'sub' ? 'destination-out' : 'source-over';
    fillPath(mctx, path);
  }
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.globalCompositeOperation = 'source-over';

  const frag = frame.readRegion(rect);
  const fctx = frag.getContext('2d');
  fctx.globalCompositeOperation = 'destination-in';
  fctx.drawImage(mask, 0, 0);
  fctx.globalCompositeOperation = 'source-over';
  return { canvas: frag, mask, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

// erases the selection's shape (fragment.mask, at fragment.x/y) from ctx,
// whose canvas's top-left sits at ox/oy (layer pixels)
export function clearMaskOnContext(ctx, fragment, ox, oy) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(fragment.mask, fragment.x - ox, fragment.y - oy);
  ctx.restore();
}

export function clearMaskArea(frame, fragment) {
  frame.drawWith({ x: fragment.x, y: fragment.y, w: fragment.w, h: fragment.h }, (ctx, ox, oy) => {
    clearMaskOnContext(ctx, fragment, ox, oy);
  }, { create: false });
}

// ---- the combined outline of a multi-region selection ----
// The regions are drawn into a coarse mask (added ones filled, cut-out ones
// erased), and the mask's boundary is traced into closed loops: one outline
// for overlapping additions, holes where something was cut out — the shape
// ✓ will actually lift. Only for showing; lifting uses the exact regions.

const OUTLINE_GRID = 900; // mask cells along the longer side

// Ramer–Douglas–Peucker on a closed loop's points
function simplify(points, tolerance) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = points[a];
    const pb = points[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i].x - pa.x) * dy - (points[i].y - pa.y) * dx) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// loops (document space) around the selected area of regions; [] if none
export function regionsOutline(regions) {
  const added = regions.filter(r => r.mode !== 'sub');
  if (!added.length) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { path } of added) {
    const b = pathBoundingBox(path);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  const cell = Math.max(x1 - x0, y1 - y0, 1) / OUTLINE_GRID;
  // a blank cell all round, so every loop closes inside the grid
  const ox = x0 - cell;
  const oy = y0 - cell;
  const gw = Math.ceil((x1 - x0) / cell) + 3;
  const gh = Math.ceil((y1 - y0) / cell) + 3;

  const c = document.createElement('canvas');
  c.width = gw;
  c.height = gh;
  const ctx = c.getContext('2d');
  ctx.setTransform(1 / cell, 0, 0, 1 / cell, -ox / cell, -oy / cell);
  ctx.fillStyle = '#000';
  for (const { path, mode } of regions) {
    ctx.globalCompositeOperation = mode === 'sub' ? 'destination-out' : 'source-over';
    fillPath(ctx, path);
  }
  const data = ctx.getImageData(0, 0, gw, gh).data;
  releaseCanvas(c);
  const inside = new Uint8Array(gw * gh);
  for (let i = 0; i < inside.length; i++) inside[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  const at = (x, y) => (x >= 0 && y >= 0 && x < gw && y < gh ? inside[y * gw + x] : 0);

  // directed boundary edges between grid corners, inside on the right;
  // corner key → edges leaving it
  const out = new Map();
  const key = (x, y) => y * (gw + 1) + x;
  const addEdge = (ax, ay, bx, by) => {
    const k = key(ax, ay);
    const e = { bx, by, used: false };
    const list = out.get(k);
    if (list) list.push(e);
    else out.set(k, [e]);
  };
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!inside[y * gw + x]) continue;
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y); // top, left → right
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1); // right, down
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1); // bottom, right → left
      if (!at(x - 1, y)) addEdge(x, y + 1, x, y); // left, up
    }
  }

  const loops = [];
  for (const [k, list] of out) {
    for (const first of list) {
      if (first.used) continue;
      const sx = k % (gw + 1);
      const sy = Math.floor(k / (gw + 1));
      const pts = [{ x: sx, y: sy }];
      let e = first;
      while (e && !e.used) {
        e.used = true;
        pts.push({ x: e.bx, y: e.by });
        e = out.get(key(e.bx, e.by))?.find(n => !n.used);
      }
      if (pts.length < 4) continue;
      // grid corners → document units, staircase smoothed out. The loop
      // ends where it starts, which simplify() can't take whole (a zero-length
      // baseline): split it at the point farthest from the start.
      let far = 0;
      let farD = -1;
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i].x - sx) ** 2 + (pts[i].y - sy) ** 2;
        if (d > farD) { farD = d; far = i; }
      }
      const smooth = [...simplify(pts.slice(0, far + 1), 0.9), ...simplify(pts.slice(far), 0.9).slice(1, -1)];
      const docPts = smooth.map(p => ({ x: ox + p.x * cell, y: oy + p.y * cell }));
      if (docPts.length >= 3) loops.push(docPts);
    }
  }
  return loops;
}
