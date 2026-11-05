// "Merge down": a layer and the one under it become one layer that looks
// exactly like the two did — each with its opacity — at every moment of
// the animation. The layers can have different frames and frame lengths,
// so the merged layer gets a frame for every stretch of time in which
// neither of them changes frame.
//
// Frames are composited tile by tile and encoded right away, so a long
// animation is never held decoded; a pair of frames that comes round again
// (a short layer looping) reuses the same encoded tiles.

import { Frame, TILE, encodeCanvas, isTransparent, newTileCanvas, releaseCanvas } from './Frame.js';

// the tiles of a and b laid over each other ({ x, y, blob } list).
// parts: [{ frame, opacity, clip }] bottom first; clip: { w, h } — only
// the camera rect of that part shows (a video layer is black past it)
async function compositeTiles(parts, encoding) {
  const keys = new Map();
  for (const { frame } of parts) {
    if (!frame) continue;
    for (const t of frame.tiles.values()) keys.set(`${t.tx},${t.ty}`, [t.tx, t.ty]);
  }
  const out = [];
  for (const [k, [tx, ty]] of keys) {
    const c = newTileCanvas();
    const ctx = c.getContext('2d');
    for (const { frame, opacity, clip } of parts) {
      const t = frame?.tiles.get(k);
      if (!t?.canvas) continue;
      ctx.save();
      ctx.globalAlpha = opacity;
      if (clip) {
        ctx.beginPath();
        ctx.rect(-tx * TILE, -ty * TILE, clip.w, clip.h);
        ctx.clip();
      }
      ctx.drawImage(t.canvas, 0, 0);
      ctx.restore();
    }
    if (!isTransparent(c)) out.push({ x: tx, y: ty, blob: await encodeCanvas(c, encoding) });
    releaseCanvas(c);
  }
  return out;
}

// the merged picture (and fill borders) of one lower frame + one upper frame
async function mergePair(lower, fl, upper, fu, encoding) {
  const frames = [fl, fu, fl?.guide, fu?.guide].filter(Boolean);
  for (const f of frames) f.pins++; // stay decoded while we read them
  try {
    for (const f of frames) await f.load();
    const camera = { w: lower.pixelWidth, h: lower.pixelHeight };
    const clipFor = l => (l.encoding === 'jpeg' && encoding !== 'jpeg' ? camera : null);
    const tiles = await compositeTiles([
      { frame: fl, opacity: lower.opacity, clip: clipFor(lower) },
      { frame: fu, opacity: upper.opacity, clip: clipFor(upper) },
    ], encoding);
    const guide = await compositeTiles([
      { frame: fl?.guide, opacity: 1, clip: null },
      { frame: fu?.guide, opacity: 1, clip: null },
    ], 'png');
    return { tiles, guide };
  } finally {
    for (const f of frames) f.pins--;
  }
}

// works out the merged frames for upper + the layer under it; returns
// { lower, frames, encoding } — the caller swaps them in. onProgress(done, total)
export async function mergeDown(layerManager, upper, onProgress) {
  const i = layerManager.layers.indexOf(upper);
  const lower = layerManager.layers[i - 1];
  if (!lower) return null;

  // as long as the longer of the two; past its end the shorter one is empty
  const T = Math.max(lower.totalDuration, upper.totalDuration);

  // a new frame wherever either layer moves on to its next frame
  // (from 0: the merged layer starts there, whenever the two did)
  const starts = new Set([0]);
  for (const l of [lower, upper]) {
    let t = l.start;
    for (const f of l.frames) {
      starts.add(t);
      t += f.duration;
    }
    if (t < T) starts.add(t); // where it ends
  }
  const sorted = [...starts].sort((a, b) => a - b);

  // JPEG only if both were (opaque video on video); anything else keeps
  // transparency
  const encoding = lower.encoding === 'jpeg' && upper.encoding === 'jpeg' ? 'jpeg' : 'png';
  const made = new Map(); // "lower index,upper index" -> merged tiles
  const frames = [];
  for (let k = 0; k < sorted.length; k++) {
    const t0 = sorted[k];
    const t1 = k + 1 < sorted.length ? sorted[k + 1] : T;
    const li = lower.frameIndexAtTime(t0);
    const ui = upper.frameIndexAtTime(t0);
    const key = `${li},${ui}`;
    let m = made.get(key);
    if (!m) {
      m = await mergePair(lower, lower.frames[li] ?? null, upper, upper.frames[ui] ?? null, encoding);
      made.set(key, m);
    }
    const f = Frame.fromTiles(lower, t1 - t0, m.tiles);
    if (m.guide.length) {
      f.guide = Frame.fromTiles(lower, t1 - t0, m.guide);
      f.guide.isGuide = true;
    }
    frames.push(f);
    onProgress?.(k + 1, sorted.length);
  }
  return { lower, frames, encoding };
}
