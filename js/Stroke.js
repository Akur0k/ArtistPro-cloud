// points closer than this (document px) to the previous one add nothing but
// jitter — skipped
const MIN_STEP = 0.5;

// reflection of `b` through `a` — stands in for the missing neighbour
// before the first / after the last sample when there are only two
const reflect = (a, b) => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y, pressure: a.pressure });

// the point that would follow a, b, c if the line kept turning the way it
// turns at b — a better stand-in neighbour at the ends than a reflection,
// which would straighten the first and last segment of a curve
const MAX_TURN = Math.PI / 3;
function continueCurve(a, b, c) {
  const turn = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
  const t = Math.max(-MAX_TURN, Math.min(MAX_TURN, Math.atan2(Math.sin(turn), Math.cos(turn))));
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { x: c.x + vx * cos - vy * sin, y: c.y + vx * sin + vy * cos, pressure: c.pressure };
}

// Cubic Bézier control points for the centripetal Catmull–Rom segment
// p1→p2 (neighbours p0, p3). The curve passes through every sample with no
// kinks, and the centripetal parametrization keeps it from overshooting or
// looping where samples are unevenly spaced — e.g. the first sample of a
// fast stroke lands far from the touch-down point.
function segmentControls(p0, p1, p2, p3) {
  const d1 = Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y));
  const d2 = Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y));
  const d3 = Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y));
  const c1 = d1 < 1e-6 ? p1 : {
    x: (d1 * d1 * p2.x - d2 * d2 * p0.x + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.x) / (3 * d1 * (d1 + d2)),
    y: (d1 * d1 * p2.y - d2 * d2 * p0.y + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.y) / (3 * d1 * (d1 + d2)),
  };
  const c2 = d3 < 1e-6 ? p2 : {
    x: (d3 * d3 * p1.x - d2 * d2 * p3.x + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.x) / (3 * d3 * (d3 + d2)),
    y: (d3 * d3 * p1.y - d2 * d2 * p3.y + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.y) / (3 * d3 * (d3 + d2)),
  };
  return [c1, c2];
}

// Draws a stroke incrementally as it comes in, as a Catmull–Rom spline
// through the samples. A segment needs the sample after it to know its
// shape, so drawing runs one sample behind the finger; end() draws the
// rest. (The previous approach — straight first piece, then curves between
// midpoints — showed a straight bit and a corner at the start of fast
// strokes, where samples are far apart.)
//
// paint(box, draw): the surface. box is the document-space area the piece
// can touch ({ x0, y0, x1, y1 }); draw(ctx) draws it on a context in
// document units with the stroke's color / blend mode already set (it may
// be called once per tile the box spans).
export class StrokeRenderer {
  constructor(paint) {
    this.paint = paint;
    this.points = [];
    this.baseWidth = 1;
    // set: every piece this wide, whatever the pressure (fill borders)
    this.fixedWidth = null;
  }

  begin(point, baseWidth) {
    this.points = [point];
    this.baseWidth = baseWidth;
    const radius = (this.fixedWidth ?? baseWidth * point.pressure) / 2;
    const m = radius + 1;
    this.paint({ x0: point.x - m, y0: point.y - m, x1: point.x + m, y1: point.y + m }, ctx => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    });
  }

  extend(point, baseWidth) {
    const last = this.points[this.points.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_STEP) return;
    this.baseWidth = baseWidth;
    this.points.push(point);
    const n = this.points.length;
    if (n >= 3) this._segment(n - 3); // the segment that just got its right-hand neighbour
  }

  // draws samples[i] → samples[i + 1]
  _segment(i) {
    const pts = this.points;
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p0 = i > 0 ? pts[i - 1]
      : pts.length >= 3 ? continueCurve(pts[2], pts[1], pts[0]) : reflect(p1, p2);
    const p3 = i + 2 < pts.length ? pts[i + 2]
      : i >= 1 ? continueCurve(pts[i - 1], p1, p2) : reflect(p2, p1);
    const [c1, c2] = segmentControls(p0, p1, p2, p3);
    const lineWidth = this.fixedWidth ?? this.baseWidth * ((p1.pressure + p2.pressure) / 2);
    // a Bézier stays inside the box of its control points
    const m = lineWidth / 2 + 2;
    const xs = [p1.x, c1.x, c2.x, p2.x];
    const ys = [p1.y, c1.y, c2.y, p2.y];
    const box = { x0: Math.min(...xs) - m, y0: Math.min(...ys) - m, x1: Math.max(...xs) + m, y1: Math.max(...ys) + m };
    this.paint(box, ctx => {
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
      ctx.stroke();
    });
  }

  // the last segment, up to where the finger lifted
  end() {
    const n = this.points.length;
    if (n >= 2) this._segment(n - 2);
    this.points = [];
  }
}
