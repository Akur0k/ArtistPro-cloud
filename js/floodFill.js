function colorsMatch(data, idx4, r, g, b, a, tolerance) {
  return (
    Math.abs(data[idx4] - r) <= tolerance &&
    Math.abs(data[idx4 + 1] - g) <= tolerance &&
    Math.abs(data[idx4 + 2] - b) <= tolerance &&
    Math.abs(data[idx4 + 3] - a) <= tolerance
  );
}

// returns the filled area's bounding box (canvas pixels, inclusive), or
// null if there was nothing to fill. beforeWrite(box) runs just before the
// canvas is changed (to save what's there for undo).
// walls: optional Uint8Array (1 = a fill border there) the fill stops at;
// seep: how many pixels the fill then creeps into those borders, so no
// unpainted seam is left under a border line. out.filled receives the
// filled pixels (Uint8Array, 1 = filled) when out is given.
export function floodFill(ctx, width, height, startX, startY, fillColor, tolerance = 24, beforeWrite = null, walls = null, seep = 0, out = null) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const startIdx = startY * width + startX;
  const startIdx4 = startIdx * 4;

  const targetR = data[startIdx4];
  const targetG = data[startIdx4 + 1];
  const targetB = data[startIdx4 + 2];
  const targetA = data[startIdx4 + 3];

  const [fr, fg, fb, fa] = fillColor;

  if (colorsMatch(data, startIdx4, fr, fg, fb, fa, 0)) return null;
  if (walls?.[startIdx]) return null; // tapped right on a border

  const visited = new Uint8Array(width * height);
  const stack = [startIdx];
  visited[startIdx] = 1;

  let minX = startX, maxX = startX, minY = startY, maxY = startY;

  while (stack.length) {
    const idx = stack.pop();
    const idx4 = idx * 4;
    data[idx4] = fr;
    data[idx4 + 1] = fg;
    data[idx4 + 2] = fb;
    data[idx4 + 3] = fa;

    const x = idx % width;
    const y = (idx / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    if (x > 0) tryPush(idx - 1);
    if (x < width - 1) tryPush(idx + 1);
    if (y > 0) tryPush(idx - width);
    if (y < height - 1) tryPush(idx + width);
  }

  function tryPush(nIdx) {
    if (visited[nIdx] || walls?.[nIdx]) return;
    const nIdx4 = nIdx * 4;
    if (colorsMatch(data, nIdx4, targetR, targetG, targetB, targetA, tolerance)) {
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  }

  // creep into the border lines next to the filled area, a few pixels deep
  if (walls && seep > 0) {
    let front = [];
    for (let i = 0; i < visited.length; i++) if (visited[i]) front.push(i);
    for (let step = 0; step < seep && front.length; step++) {
      const next = [];
      for (const idx of front) {
        const x = idx % width;
        const y = (idx / width) | 0;
        for (const n of [x > 0 ? idx - 1 : -1, x < width - 1 ? idx + 1 : -1, y > 0 ? idx - width : -1, y < height - 1 ? idx + width : -1]) {
          if (n < 0 || visited[n] || !walls[n]) continue;
          const n4 = n * 4;
          // only where the fill would have gone without the border — not
          // over a drawn line the border happens to cross
          if (!colorsMatch(data, n4, targetR, targetG, targetB, targetA, tolerance)) continue;
          visited[n] = 1;
          next.push(n);
          data[n4] = fr;
          data[n4 + 1] = fg;
          data[n4 + 2] = fb;
          data[n4 + 3] = fa;
          const nx = n % width;
          const ny = (n / width) | 0;
          if (nx < minX) minX = nx;
          if (nx > maxX) maxX = nx;
          if (ny < minY) minY = ny;
          if (ny > maxY) maxY = ny;
        }
      }
      front = next;
    }
  }

  if (out) out.filled = visited;
  const rectW = maxX - minX + 1;
  const rectH = maxY - minY + 1;
  beforeWrite?.({ minX, minY, maxX, maxY });
  ctx.putImageData(imageData, 0, 0, minX, minY, rectW, rectH);
  return { minX, minY, maxX, maxY };
}
