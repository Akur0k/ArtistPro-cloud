// The computer version sends a diagnostics log to the dev server; the
// cloud version has no server, so logging is a no-op (the calls stay so
// the rest of the code is the same in both).

export function dlog() {}

export function setStateProvider() {}

export function domCanvasStats() {
  let n = 0;
  let px = 0;
  for (const c of document.getElementsByTagName('canvas')) {
    n++;
    px += c.width * c.height;
  }
  return { n, mpx: +(px / 1e6).toFixed(1) };
}
