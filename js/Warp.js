// A picture pulled onto any four-cornered shape (perspective / free
// distort): its top-left, top-right, bottom-right and bottom-left corners
// go to the quad's four points and everything between follows a projective
// mapping, so straight lines stay straight.

// the mapping from the unit square (s, t in 0..1) onto quad [p0, p1, p2, p3]
// (Heckbert's square-to-quad); returns { map(s, t) -> {x, y}, unmap(x, y) -> {s, t} }
export function squareToQuad(quad) {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let a, b, c, d, e, f, g, h;
  const det = dx1 * dy2 - dx2 * dy1;
  if ((Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) || Math.abs(det) < 1e-12) {
    // a parallelogram (or degenerate): plain affine
    a = p1.x - p0.x; b = p3.x - p0.x; c = p0.x;
    d = p1.y - p0.y; e = p3.y - p0.y; f = p0.y;
    g = 0; h = 0;
  } else {
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
    a = p1.x - p0.x + g * p1.x; b = p3.x - p0.x + h * p3.x; c = p0.x;
    d = p1.y - p0.y + g * p1.y; e = p3.y - p0.y + h * p3.y; f = p0.y;
  }
  // the inverse (adjugate of [[a b c] [d e f] [g h 1]]; the scale cancels out)
  const A = e - f * h, B = c * h - b, C = b * f - c * e;
  const D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  return {
    map(s, t) {
      const w = g * s + h * t + 1;
      return { x: (a * s + b * t + c) / w, y: (d * s + e * t + f) / w };
    },
    unmap(x, y) {
      const w = G * x + H * y + I;
      return { s: (A * x + B * y + C) / w, t: (D * x + E * y + F) / w };
    },
  };
}

// live preview: src (its whole canvas) drawn onto quad in ctx's current
// coordinates, as n×n cells of two triangles each, every one an affine
// piece of the mapping — close enough at a glance, and fast
export function drawWarped(ctx, src, quad, n = 10) {
  const m = squareToQuad(quad);
  const W = src.width, H = src.height;
  // a device pixel in ctx's units: how far each triangle reaches over its neighbours
  const t = ctx.getTransform();
  const px = 1 / Math.sqrt(Math.abs(t.a * t.d - t.b * t.c) || 1);
  const pts = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) pts.push(m.map(i / n, j / n));
  }
  const at = (i, j) => pts[j * (n + 1) + i];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u0 = (i / n) * W, u1 = ((i + 1) / n) * W;
      const v0 = (j / n) * H, v1 = ((j + 1) / n) * H;
      triangle(ctx, src, [u0, v0, u1, v0, u0, v1], [at(i, j), at(i + 1, j), at(i, j + 1)], px);
      triangle(ctx, src, [u1, v0, u1, v1, u0, v1], [at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], px);
    }
  }
}

// source triangle (pixel coords u,v ×3) onto dest triangle d (3 points);
// px: a device pixel in ctx's units
function triangle(ctx, src, s, d, px) {
  const [u0, v0, u1, v1, u2, v2] = s;
  const den = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (!den) return;
  // affine [a c e; b d f] with (u, v) -> (x, y)
  const x0 = d[0].x, y0 = d[0].y, x1 = d[1].x, y1 = d[1].y, x2 = d[2].x, y2 = d[2].y;
  const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / den;
  const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / den;
  const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / den;
  const dd = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / den;
  const e = x0 - a * u0 - c * v0;
  const f = y0 - b * u0 - dd * v0;
  // clip about a pixel wider than the triangle, so neighbours leave no seam
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
  const grow = p => {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const k = 1 + Math.min(0.5, (1.5 * px) / len);
    return { x: cx + dx * k, y: cy + dy * k };
  };
  const g0 = grow(d[0]), g1 = grow(d[1]), g2 = grow(d[2]);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(g0.x, g0.y);
  ctx.lineTo(g1.x, g1.y);
  ctx.lineTo(g2.x, g2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, dd, e, f);
  ctx.drawImage(src, 0, 0);
  ctx.restore();
}

// the final picture: src pulled onto quad (in output pixels), sampled pixel
// by pixel (bilinear, premultiplied — no dark fringe on soft edges).
// Returns { canvas, x, y }: x, y where the canvas's top-left goes
export function warpCanvas(src, quad) {
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  const x0 = Math.floor(Math.min(...xs)) - 1, y0 = Math.floor(Math.min(...ys)) - 1;
  const x1 = Math.ceil(Math.max(...xs)) + 1, y1 = Math.ceil(Math.max(...ys)) + 1;
  const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0);
  const sw = src.width, sh = src.height;
  const sdata = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H);
  const o = img.data;
  const m = squareToQuad(quad);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const { s, t } = m.unmap(x0 + x + 0.5, y0 + y + 0.5);
      if (!(s > -0.01 && s < 1.01 && t > -0.01 && t < 1.01)) continue;
      // source pixel centres
      const u = s * sw - 0.5, v = t * sh - 0.5;
      const ui = Math.floor(u), vi = Math.floor(v);
      const fu = u - ui, fv = v - vi;
      let r = 0, gg = 0, bb = 0, al = 0;
      for (let k = 0; k < 4; k++) {
        const px = ui + (k & 1), py = vi + (k >> 1);
        if (px < 0 || py < 0 || px >= sw || py >= sh) continue;
        const wgt = ((k & 1) ? fu : 1 - fu) * ((k >> 1) ? fv : 1 - fv);
        const i = (py * sw + px) * 4;
        const aw = sdata[i + 3] * wgt;
        r += sdata[i] * aw;
        gg += sdata[i + 1] * aw;
        bb += sdata[i + 2] * aw;
        al += aw;
      }
      if (al <= 0) continue;
      const j = (y * W + x) * 4;
      o[j] = r / al;
      o[j + 1] = gg / al;
      o[j + 2] = bb / al;
      o[j + 3] = al;
    }
  }
  octx.putImageData(img, 0, 0);
  return { canvas: out, x: x0, y: y0 };
}
