// Safari on iOS now and then doesn't turn a tap into a click at all — most
// often right after a gesture on the canvas (a stroke, two-finger zoom),
// and the button press was simply lost. So for touch and pen, every button
// fires on finger-up: a click is dispatched then, and the real click that
// may still follow is swallowed. Mouse and keyboard keep plain clicks.
//
// Buttons marked data-native-tap are left alone: they open a file picker or
// the share sheet, which iOS only allows from a genuine click.

const SLOP = 10; // px a finger may drift off the button and still count
const SWALLOW_MS = 800;

export function installTapFix() {
  let down = null; // { btn, id }
  let swallowUntil = 0; // the real click of a tap already handled

  const buttonOf = target => {
    const btn = target?.closest?.('button');
    return btn && !btn.hasAttribute('data-native-tap') ? btn : null;
  };

  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const btn = buttonOf(e.target);
    down = btn ? { btn, id: e.pointerId } : null;
  }, true);

  document.addEventListener('pointercancel', e => {
    if (down?.id === e.pointerId) down = null;
  }, true);

  document.addEventListener('pointerup', e => {
    if (!down || down.id !== e.pointerId) return;
    const { btn } = down;
    down = null;
    const r = btn.getBoundingClientRect();
    const inside = e.clientX >= r.left - SLOP && e.clientX <= r.right + SLOP &&
      e.clientY >= r.top - SLOP && e.clientY <= r.bottom + SLOP;
    if (!inside || btn.disabled) return;
    swallowUntil = performance.now() + SWALLOW_MS;
    btn.click();
  }, true);

  // that real click lands wherever the finger was — by then the button may
  // have changed the layout (the selection bar grows), so it's dropped
  // whatever it hits
  document.addEventListener('click', e => {
    if (!e.isTrusted || performance.now() >= swallowUntil) return;
    swallowUntil = 0; // only that one click
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}
