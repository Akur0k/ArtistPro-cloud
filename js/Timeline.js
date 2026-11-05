import { readFrameImage, drawFrameImage } from './Frame.js';
import { setIcon } from './Icons.js';

const ZOOM_LEVELS = [16, 24, 32, 40, 60, 80, 120];
const DEFAULT_ZOOM_INDEX = 3; // 40px per tick
const THUMB_SIZE = 52;
const DRAG_THRESHOLD = 8;
const HOLD_MS = 250;
// a finger has to go this far sideways (and clearly more sideways than up
// or down) before the frames scroll — brushing the timeline doesn't move it
const SWIPE_START = 24;
// up/down (more layers than fit) starts sooner — that's not easy to set off
// by accident
const VSWIPE_START = 10;
// a flung timeline keeps going, slowing by this factor per millisecond
// (about what an iOS list does)
const FLING_DECAY = 0.997;
const TICKS_PER_SECOND = 12; // playback rate (main.js plays at 1000/12 ms)
// room past the last frame, so the end marker can be pulled further out
const SLACK_TICKS = 6;

function ticksLabel(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'тик'
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'тика' : 'тиков';
  const secs = (n / TICKS_PER_SECOND).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  return `${n} ${word} · ${secs} с`;
}

export class Timeline {
  constructor(layerManager, els, callbacks = {}) {
    this.layerManager = layerManager;
    this.labelsEl = els.labelsEl;
    this.innerEl = els.innerEl;
    this.playheadEl = els.playheadEl;
    this.rulerEl = els.rulerEl;
    this.indicatorEl = els.indicatorEl;

    this.onSelect = callbacks.onSelect ?? (() => {});
    this.onDurationChange = callbacks.onDurationChange ?? (() => {});
    this.onActivateLayer = callbacks.onActivateLayer ?? (() => {});
    this.onReorder = callbacks.onReorder ?? (() => {});
    // (layer, frameIndex, tick): a frame dragged to start at that tick
    this.onFrameDrop = callbacks.onFrameDrop ?? (() => {});
    this.onAddFrame = callbacks.onAddFrame ?? (() => {});
    this.onScrub = callbacks.onScrub ?? (() => {});
    this.onVisibility = callbacks.onVisibility ?? (() => {});
    // (layer, frameIndex, extra): the selected frame was pulled `extra`
    // ticks longer — each of them becomes a frame of its own
    this.onStretch = callbacks.onStretch ?? null;
    this.onEndChange = callbacks.onEndChange ?? (() => {});
    // an object layer's keys: (layer, t) one tapped; (layer, from, to) one
    // dragged to another tick
    this.onKeySelect = callbacks.onKeySelect ?? (() => {});
    this.onKeyMove = callbacks.onKeyMove ?? (() => {});

    this.scrollEl = els.scrollEl;
    // the labels scroll up/down together with the tracks (only a couple of
    // tracks fit; the rest scroll), the time ruler above them stays put
    this.labelListEl = document.createElement('div');
    this.labelListEl.className = 'track-label-list';
    this.labelsEl.appendChild(this.labelListEl);
    let syncing = false;
    const sync = (from, to) => () => {
      if (syncing) return;
      syncing = true;
      to.scrollTop = from.scrollTop;
      syncing = false;
    };
    this.scrollEl.addEventListener('scroll', sync(this.scrollEl, this.labelListEl), { passive: true });
    this.labelListEl.addEventListener('scroll', sync(this.labelListEl, this.scrollEl), { passive: true });

    this.zoomIndex = DEFAULT_ZOOM_INDEX;
    this._cellDragging = false;
    this._flingRaf = 0;
    this._caught = false; // this touch stopped a flung timeline
    this._makeEndMarker();
    this._wireRuler();
    this._wireSwipe();
    this._makeScrollbar();
    this._thumbObserver = null;
  }

  // thumbnails are the expensive part of a render (downscaling a full-res
  // frame canvas into a 52x52 canvas, once per frame cell) — on a project
  // with hundreds/thousands of frames that adds up to real main-thread time.
  // Draw only the ones actually scrolled into view; the rest get filled in
  // lazily as the user scrolls the timeline. Recreated on every render()
  // (rather than reused) so old, removed cells don't linger as observed
  // targets forever.
  _makeThumbObserver() {
    this._thumbObserver?.disconnect();
    if (typeof IntersectionObserver === 'undefined') {
      this._thumbObserver = null;
      return;
    }
    this._thumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this._thumbObserver.unobserve(entry.target);
        const info = entry.target._tlThumbInfo;
        if (info) this._drawCellThumb(info.layer, info.frameIndex, info.cell);
      }
    }, { root: this.scrollEl || null, rootMargin: '300px' });
  }

  get pxPerTick() {
    return ZOOM_LEVELS[this.zoomIndex];
  }

  zoomIn() {
    this.zoomIndex = Math.min(ZOOM_LEVELS.length - 1, this.zoomIndex + 1);
    this.render();
  }

  zoomOut() {
    this.zoomIndex = Math.max(0, this.zoomIndex - 1);
    this.render();
  }

  refreshThumbnail(layer, frameIndex) {
    const cell = layer._tlCells?.[frameIndex];
    if (!cell?._strip) return;
    this._thumbObserver?.unobserve(cell._strip);
    this._drawCellThumb(layer, frameIndex, cell);
  }

  updatePlayhead() {
    const x = this.layerManager.playhead * this.pxPerTick;
    this.playheadEl.style.transform = `translateX(${x}px)`;
    const active = this.layerManager.activeLayer;
    const t = this.layerManager.playhead;
    for (const layer of this.layerManager.layers) {
      for (const d of layer._tlKeys || []) d.classList.toggle('current', d._t === t);
      const cells = layer._tlCells || [];
      // past its end a layer has no frame under the playhead
      cells.forEach((cell, i) => cell.classList.toggle('active', !layer.ended && i === layer.currentFrameIndex));
      // only the selected frame (active layer's current one) shows a resize handle
      layer._tlRow?.classList.toggle('active-layer', layer === active);
    }
    if (this.indicatorEl && active?.kind === 'object') {
      const i = active.keys.findIndex(k => k.t === t);
      this.indicatorEl.textContent = `ключ ${i >= 0 ? i + 1 : '—'}/${active.keys.length}`;
    } else if (this.indicatorEl && active) {
      this.indicatorEl.textContent = active.ended ? `—/${active.frameCount}` : `${active.currentFrameIndex + 1}/${active.frameCount}`;
    }
  }

  render() {
    this._makeThumbObserver();
    this.labelListEl.replaceChildren();
    this.innerEl.querySelectorAll('.track-row').forEach(el => el.remove());

    const activeLayer = this.layerManager.activeLayer;

    // the top layer first — the same order as the layers panel
    for (const layer of [...this.layerManager.layers].reverse()) {
      layer._tlCells = [];

      const label = document.createElement('div');
      label.className = 'track-label' + (layer === activeLayer ? ' active' : '') + (layer.visible ? '' : ' hidden-layer');
      const name = document.createElement('span');
      name.className = 'track-label-name';
      name.textContent = layer.name;
      const eye = document.createElement('button');
      eye.className = 'track-eye';
      eye.title = layer.visible ? 'Скрыть слой' : 'Показать слой';
      setIcon(eye, layer.visible ? 'eye' : 'eye-off');
      eye.addEventListener('click', e => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        layer.applyVisualState();
        this.render();
        this.onVisibility(layer);
      });
      label.appendChild(name);
      label.appendChild(eye);
      label.addEventListener('click', () => {
        this.layerManager.setActive(layer.id);
        this.onActivateLayer();
        this.render();
      });
      this.labelListEl.appendChild(label);

      const row = document.createElement('div');
      row.className = 'track-row';
      layer._tlRow = row;

      if (layer.kind === 'object') {
        this._fillObjectRow(layer, row);
        this.innerEl.appendChild(row);
        continue;
      }

      // nothing before the layer's start
      if (layer.start > 0) {
        const lead = document.createElement('div');
        lead.className = 'tl-lead';
        lead.style.width = `${layer.start * this.pxPerTick}px`;
        row.appendChild(lead);
      }
      // frames a movement made (or starts on) — it can be changed again
      layer._tlMotionBases = new Set(layer.frames.map(f => f.motion?.base).filter(Boolean));
      for (let i = 0; i < layer.frameCount; i++) {
        const cell = this._makeCell(layer, i);
        row.appendChild(cell);
        layer._tlCells[i] = cell;
      }

      this.innerEl.appendChild(row);
    }

    this.innerEl.style.setProperty('--tick', `${this.pxPerTick}px`);
    this._renderRuler();
    this.updatePlayhead();
    this._updateScrollbar();
    this.revealActive();
  }

  // the selected layer's track scrolled into view, if it's out of it (one
  // track showing: that's the one)
  revealActive() {
    const row = this.layerManager.activeLayer?._tlRow;
    const el = this.scrollEl;
    if (!row || !el.clientHeight) return;
    const ruler = this.rulerEl.offsetHeight;
    const top = row.offsetTop - ruler;
    const bottom = row.offsetTop + row.offsetHeight - el.clientHeight;
    let to = el.scrollTop;
    if (el.scrollTop > top) to = top;
    else if (el.scrollTop < bottom) to = bottom;
    if (to !== el.scrollTop) {
      el.scrollTop = to;
      this.labelListEl.scrollTop = el.scrollTop;
    }
  }

  // the ruler and the end marker (after a layer's length or visibility changed)
  renderRuler() {
    this._renderRuler();
  }

  _renderRuler() {
    this.rulerEl.innerHTML = '';
    const total = this.layerManager.timelineLength + SLACK_TICKS;
    const px = this.pxPerTick;
    this.rulerEl.style.width = `${total * px}px`;
    const step = px >= 30 ? 1 : px >= 15 ? 5 : 10;
    for (let t = 0; t <= total; t += step) {
      const mark = document.createElement('div');
      mark.className = 'tick-mark';
      mark.style.left = `${t * px}px`;
      mark.textContent = String(t);
      this.rulerEl.appendChild(mark);
    }
    this.rulerEl.appendChild(this.endKnob);
    this._placeEnd(this.layerManager.totalDuration);
  }

  // The end of the animation: a line down the tracks, with a knob on the
  // ruler to pull it. Past it the tracks are dimmed (those frames don't
  // play or export). Left where the longest visible layer ends, it follows
  // that (a hidden layer doesn't count).
  _makeEndMarker() {
    this.endLine = document.createElement('div');
    this.endLine.className = 'tl-end-line';
    this.afterEnd = document.createElement('div');
    this.afterEnd.className = 'tl-after-end';
    this.innerEl.appendChild(this.afterEnd);
    this.innerEl.appendChild(this.endLine);
    this.endKnob = document.createElement('div');
    this.endKnob.className = 'tl-end-knob';
    this.endKnob.title = 'Конец анимации — потяните';

    this.endKnob.addEventListener('pointerdown', e => {
      e.stopPropagation(); // not a scrub
      e.preventDefault();
      this.endKnob.setPointerCapture(e.pointerId);
      const lm = this.layerManager;
      const tip = document.createElement('div');
      tip.className = 'tl-resize-tip';
      document.body.appendChild(tip);
      const tickAt = x => Math.max(1, Math.round((x - this.innerEl.getBoundingClientRect().left) / this.pxPerTick));
      let end = lm.totalDuration;
      const show = () => {
        this._placeEnd(end, end === lm.autoDuration);
        tip.textContent = `Конец: ${ticksLabel(end)}${end === lm.autoDuration ? ' (по слоям)' : ''}`;
        const r = this.endKnob.getBoundingClientRect();
        tip.style.left = `${r.left + r.width / 2}px`;
        tip.style.top = `${r.top}px`;
      };
      show();
      const onMove = ev => {
        end = tickAt(ev.clientX);
        show();
      };
      const onUp = () => {
        this.endKnob.removeEventListener('pointermove', onMove);
        this.endKnob.removeEventListener('pointerup', onUp);
        this.endKnob.removeEventListener('pointercancel', onUp);
        tip.remove();
        // dropped where the layers end: follows them again
        lm.endTime = end === lm.autoDuration ? null : end;
        this.onEndChange();
        this.render();
      };
      this.endKnob.addEventListener('pointermove', onMove);
      this.endKnob.addEventListener('pointerup', onUp);
      this.endKnob.addEventListener('pointercancel', onUp);
    });
  }

  _placeEnd(end, auto = this.layerManager.endTime == null) {
    const x = end * this.pxPerTick;
    this.endLine.style.transform = `translateX(${x}px)`;
    this.endKnob.style.left = `${x}px`;
    this.afterEnd.style.left = `${x}px`;
    this.endKnob.classList.toggle('auto', auto);
    this.endLine.classList.toggle('auto', auto);
  }

  // A frame cell looks like a clip on an editing timeline: its picture
  // repeats along the whole width like a filmstrip (a frame held for 3
  // ticks shows 3+ copies, not one picture and empty space), thin marks
  // divide it into ticks, a badge gives the length, and the selected frame
  // gets a bracket-shaped trim handle on its right edge.
  _makeCell(layer, frameIndex) {
    const duration = layer.frameDurationAt(frameIndex);

    const cell = document.createElement('div');
    cell.className = 'tl-frame-cell' + (!layer.ended && frameIndex === layer.currentFrameIndex ? ' active' : '');
    cell.style.width = `${duration * this.pxPerTick}px`;
    const frame = layer.frames[frameIndex];
    if (frame.motion || layer._tlMotionBases?.has(frame)) cell.classList.add('tl-motion');
    // an empty stretch between frames: nothing to show or drag; a tap
    // goes to the tick tapped
    if (frame.gap && frame.isBlank) {
      cell.classList.add('tl-gap');
      let down = null;
      cell.addEventListener('pointerdown', e => { down = this._caught ? null : { x: e.clientX, y: e.clientY }; });
      cell.addEventListener('click', e => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_THRESHOLD) return;
        let t = layer.start;
        for (let i = 0; i < frameIndex; i++) t += layer.frameDurationAt(i);
        const r = cell.getBoundingClientRect();
        this.onKeySelect(layer, t + Math.max(0, Math.floor((e.clientX - r.left) / this.pxPerTick)));
      });
      return cell;
    }

    // the strip tile keeps the document's aspect (no squashing a portrait
    // canvas into a square); drawn into an offscreen canvas, then used as
    // the strip's repeating background
    const tileW = Math.max(20, Math.min(96, Math.round(THUMB_SIZE * layer.pixelWidth / layer.pixelHeight)));
    const thumb = document.createElement('canvas');
    thumb.width = tileW * 2;
    thumb.height = THUMB_SIZE * 2;
    cell._thumb = thumb;

    const strip = document.createElement('div');
    strip.className = 'tl-strip';
    strip.style.backgroundSize = `${tileW}px 100%`;
    cell._strip = strip;
    cell.appendChild(strip);

    const ticks = document.createElement('div');
    ticks.className = 'tl-ticks';
    cell.appendChild(ticks);

    const badge = document.createElement('div');
    badge.className = 'tl-dur';
    cell._badge = badge;
    this._setBadge(cell, duration);
    cell.appendChild(badge);

    if (this._thumbObserver) {
      strip._tlThumbInfo = { layer, frameIndex, cell };
      this._thumbObserver.observe(strip);
    } else {
      this._drawCellThumb(layer, frameIndex, cell);
    }

    const handle = document.createElement('div');
    handle.className = 'tl-resize-handle';
    handle.innerHTML = '<span class="tl-resize-grip"></span>';
    handle.addEventListener('click', e => e.stopPropagation());
    this._wireResize(handle, layer, frameIndex, cell);
    cell.appendChild(handle);

    this._wireCellDrag(cell, layer, frameIndex);

    return cell;
  }

  // An object layer's track: a bar over its span (first key to last) with a
  // diamond on each key. A tap on a diamond goes to that key; held (a
  // mouse: just dragged) it moves to another tick. A tap on the bar goes to
  // that tick.
  _fillObjectRow(layer, row) {
    const px = this.pxPerTick;
    row.classList.add('object-row');
    layer._tlKeys = [];
    const track = document.createElement('div');
    track.className = 'tl-object-track';
    track.style.width = `${(this.layerManager.timelineLength + 6) * px}px`;
    const first = layer.firstTick;
    const bar = document.createElement('div');
    bar.className = 'tl-object-span';
    bar.style.left = `${first * px}px`;
    bar.style.width = `${(layer.totalDuration - first) * px}px`;
    track.appendChild(bar);
    let down = null;
    track.addEventListener('pointerdown', e => { down = this._caught ? null : { x: e.clientX, y: e.clientY }; });
    track.addEventListener('click', e => {
      // a swipe or a touch that stopped a flung timeline isn't a tap
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_THRESHOLD) return;
      const r = track.getBoundingClientRect();
      this.onKeySelect(layer, Math.max(0, Math.floor((e.clientX - r.left) / px)));
    });
    for (const key of layer.keys) {
      const d = document.createElement('div');
      d.className = 'tl-key';
      d._t = key.t;
      d.style.left = `${(key.t + 0.5) * px}px`;
      this._wireKey(d, layer, key.t);
      track.appendChild(d);
      layer._tlKeys.push(d);
    }
    row.appendChild(track);
  }

  _wireKey(d, layer, t) {
    d.addEventListener('click', e => e.stopPropagation());
    d.addEventListener('pointerdown', e => {
      if (this._caught) return;
      e.stopPropagation();
      d.setPointerCapture(e.pointerId);
      const px = this.pxPerTick;
      const startX = e.clientX;
      const startY = e.clientY;
      let state = 'pending';
      let to = t;
      const lift = () => {
        state = 'drag';
        this._cellDragging = true;
        d.classList.add('dragging');
      };
      const hold = e.pointerType !== 'mouse' ? setTimeout(() => { if (state === 'pending') lift(); }, HOLD_MS) : null;
      const onMove = ev => {
        const dx = ev.clientX - startX;
        const far = Math.abs(dx) > DRAG_THRESHOLD || Math.abs(ev.clientY - startY) > DRAG_THRESHOLD;
        if (state === 'pending' && far) {
          if (e.pointerType === 'mouse') lift();
          else state = 'ignore'; // a swipe: the timeline scrolls
        }
        if (state !== 'drag') return;
        to = Math.max(0, t + Math.round(dx / px));
        d.style.left = `${(to + 0.5) * px}px`;
      };
      const onUp = ev => {
        clearTimeout(hold);
        d.removeEventListener('pointermove', onMove);
        d.removeEventListener('pointerup', onUp);
        d.removeEventListener('pointercancel', onUp);
        d.classList.remove('dragging');
        this._cellDragging = false;
        if (state === 'drag') {
          if (to !== t && ev.type === 'pointerup') this.onKeyMove(layer, t, to);
          else d.style.left = `${(t + 0.5) * px}px`;
        } else if (state === 'pending' && ev.type === 'pointerup') {
          this.onKeySelect(layer, t);
        }
      };
      d.addEventListener('pointermove', onMove);
      d.addEventListener('pointerup', onUp);
      d.addEventListener('pointercancel', onUp);
    });
  }

  _setBadge(cell, duration) {
    cell._badge.textContent = duration > 1 ? `×${duration}` : '';
    cell._badge.style.display = duration > 1 ? '' : 'none';
  }

  _drawCellThumb(layer, frameIndex, cell) {
    const thumb = cell._thumb;
    const ctx = thumb.getContext('2d');
    const show = () => { cell._strip.style.backgroundImage = `url(${thumb.toDataURL()})`; };
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, thumb.width, thumb.height);
    const frame = layer.frames[frameIndex];
    if (!frame || frame.isBlank) {
      show();
      return;
    }
    // an encoded frame is decoded (downscaled) just for the thumbnail —
    // it isn't made resident; the token drops a result that arrives after
    // the cell was redrawn
    const token = {};
    thumb._thumbToken = token;
    readFrameImage(frame, { width: thumb.width, height: thumb.height }).then(src => {
      if (!src) return;
      if (thumb._thumbToken === token) {
        drawFrameImage(ctx, src, thumb.width, thumb.height, this.layerManager.tintOf(layer));
        show();
      }
      src.release();
    }).catch(() => {});
  }

  _wireResize(handle, layer, frameIndex, cell) {
    handle.addEventListener('pointerdown', e => {
      // a frame that isn't selected can't be resized — let the tap fall
      // through to the cell, which selects it
      if (layer !== this.layerManager.activeLayer || layer.ended || frameIndex !== layer.currentFrameIndex) return;
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startDuration = layer.frameDurationAt(frameIndex);
      handle.setPointerCapture(e.pointerId);
      cell.classList.add('resizing');

      // floating "N тиков · X с" above the handle while dragging
      const tip = document.createElement('div');
      tip.className = 'tl-resize-tip';
      document.body.appendChild(tip);

      const liveDuration = dx => {
        const deltaTicks = Math.round(dx / this.pxPerTick);
        return Math.max(1, startDuration + deltaTicks);
      };
      const show = d => {
        cell.style.width = `${d * this.pxPerTick}px`;
        this._setBadge(cell, d);
        tip.textContent = ticksLabel(d);
        const r = handle.getBoundingClientRect();
        tip.style.left = `${r.left + r.width / 2}px`;
        tip.style.top = `${r.top}px`;
      };
      show(startDuration);

      const onMove = ev => show(liveDuration(ev.clientX - startX));
      const onUp = ev => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        tip.remove();
        cell.classList.remove('resizing');
        const d = liveDuration(ev.clientX - startX);
        if (d > startDuration && this.onStretch) {
          // longer: new frames (copies), each one can be changed on its own
          this.onStretch(layer, frameIndex, d - startDuration);
        } else {
          layer.setFrameDuration(frameIndex, d);
          this.onDurationChange();
        }
        this.render();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  // Moving a frame: only the selected frame can move — to any tick, the
  // others staying where they are (see main.js moveFrameTo). With a finger it
  // has to be pressed and held first (HOLD_MS) — that lifts it; a finger
  // that moves before then scrolls the timeline instead. With a mouse a
  // plain drag works. While dragged it moves a tick at a time; holding it
  // near either edge of the timeline scrolls it.
  _wireCellDrag(cell, layer, frameIndex) {
    cell.addEventListener('pointerdown', e => {
      // a touch that stops a flung timeline is only that, not a tap
      if (this._caught) return;
      const selected = layer === this.layerManager.activeLayer && !layer.ended && frameIndex === layer.currentFrameIndex;
      const touchLike = e.pointerType !== 'mouse';
      const scrollEl = this.scrollEl;
      const startX = e.clientX;
      const startY = e.clientY;
      const startScroll = scrollEl ? scrollEl.scrollLeft : 0;
      let lastX = startX;
      let moved = false;
      // pending: not decided yet / drag: frame lifted / scroll: finger
      // panning the timeline (the selected cell has touch-action:none, so
      // the browser won't do it there) / ignore
      let state = 'pending';
      cell.setPointerCapture(e.pointerId);

      // where it starts now (tick), and where it would land
      let origin = layer.start;
      for (let i = 0; i < frameIndex; i++) origin += layer.frameDurationAt(i);
      const px = this.pxPerTick;
      let target = origin;

      const scrollDelta = () => (scrollEl ? scrollEl.scrollLeft - startScroll : 0);

      // follows the finger a tick at a time; the other frames stay put
      const updateDrag = () => {
        const dx = lastX - startX + scrollDelta();
        target = Math.max(0, origin + Math.round(dx / px));
        cell.style.transform = `translateX(${(target - origin) * px}px)`;
      };

      let autoRaf = 0;
      const autoScroll = () => {
        autoRaf = 0;
        if (state !== 'drag' || !scrollEl) return;
        const r = scrollEl.getBoundingClientRect();
        const zone = 40;
        let v = 0;
        if (lastX < r.left + zone) v = -Math.ceil((r.left + zone - lastX) / 4);
        else if (lastX > r.right - zone) v = Math.ceil((lastX - (r.right - zone)) / 4);
        if (v) {
          scrollEl.scrollLeft += v;
          updateDrag();
        }
        autoRaf = requestAnimationFrame(autoScroll);
      };

      const lift = () => {
        state = 'drag';
        this._cellDragging = true;
        cell.classList.add('dragging');
        updateDrag();
        autoRaf = requestAnimationFrame(autoScroll);
      };

      const holdTimer = selected && touchLike
        ? setTimeout(() => { if (state === 'pending' && !moved) lift(); }, HOLD_MS)
        : null;

      const onMove = ev => {
        lastX = ev.clientX;
        if (Math.abs(ev.clientX - startX) > DRAG_THRESHOLD || Math.abs(ev.clientY - startY) > DRAG_THRESHOLD) moved = true;
        if (state === 'pending' && moved) {
          if (selected && !touchLike) lift();
          // a swipe: the timeline's own swipe handling scrolls it
          else state = 'ignore';
        }
        if (state === 'drag') updateDrag();
      };
      const onUp = ev => {
        clearTimeout(holdTimer);
        cancelAnimationFrame(autoRaf);
        cell.removeEventListener('pointermove', onMove);
        cell.removeEventListener('pointerup', onUp);
        cell.removeEventListener('pointercancel', onUp);
        cell.classList.remove('dragging');
        this._cellDragging = false;
        cell.style.transform = '';
        if (state === 'drag') {
          if (target !== origin && ev.type === 'pointerup') this.onFrameDrop(layer, frameIndex, target);
        } else if (state === 'pending' && !moved && ev.type === 'pointerup') {
          this.onSelect(layer, frameIndex);
        }
      };
      cell.addEventListener('pointermove', onMove);
      cell.addEventListener('pointerup', onUp);
      cell.addEventListener('pointercancel', onUp);
    });
  }

  _wireRuler() {
    const tickAt = clientX => {
      const rect = this.innerEl.getBoundingClientRect();
      return Math.max(0, Math.round((clientX - rect.left) / this.pxPerTick));
    };

    this.rulerEl.addEventListener('pointerdown', e => {
      this.rulerEl.setPointerCapture(e.pointerId);
      this.onScrub(tickAt(e.clientX));

      const onMove = ev => this.onScrub(tickAt(ev.clientX));
      const onUp = () => {
        this.rulerEl.removeEventListener('pointermove', onMove);
        this.rulerEl.removeEventListener('pointerup', onUp);
        this.rulerEl.removeEventListener('pointercancel', onUp);
      };
      this.rulerEl.addEventListener('pointermove', onMove);
      this.rulerEl.addEventListener('pointerup', onUp);
      this.rulerEl.addEventListener('pointercancel', onUp);
    });
  }

  // Scrolling by finger is done here, not by the browser. Sideways only a
  // deliberate swipe moves the frames (SWIPE_START), so a tap or a slip of
  // the finger leaves them where they are. Up/down too: let the browser do
  // it and a downward swipe near the bottom of an iPhone screen can set off
  // the system's Reachability (the whole screen slides down).
  // target: the tracks, or the names column (up/down only)
  _wireSwipe(target = this.scrollEl, sideways = true) {
    const el = this.scrollEl;
    let g = null;
    target.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || g) return;
      if (e.target.closest('.time-ruler')) return; // the ruler scrubs
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, left0: el.scrollLeft, top0: el.scrollTop, axis: null, samples: [] };
    });
    target.addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      if (this._cellDragging) {
        g = null;
        return;
      }
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.axis) {
        if (Math.abs(dy) > VSWIPE_START && Math.abs(dy) > Math.abs(dx)) {
          g.axis = 'y';
          g.y0 = e.clientY;
        } else if (sideways && Math.abs(dx) >= SWIPE_START && Math.abs(dx) >= 2 * Math.abs(dy)) {
          g.axis = 'x';
          g.x0 = e.clientX; // carry on from here, no jump
        } else {
          return;
        }
        this._swiped = true;
      }
      const p = g.axis === 'x' ? e.clientX : e.clientY;
      g.samples.push({ t: e.timeStamp, p });
      if (g.samples.length > 8) g.samples.shift();
      if (g.axis === 'x') {
        el.scrollLeft = g.left0 - (e.clientX - g.x0);
      } else {
        el.scrollTop = g.top0 - (e.clientY - g.y0);
        this.labelListEl.scrollTop = el.scrollTop;
      }
    });
    const end = e => {
      if (!g || e.pointerId !== g.id) return;
      if (g.axis && e.type === 'pointerup') this._fling(g.axis, -fingerSpeed(g.samples, e.timeStamp));
      g = null;
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    if (!sideways) return;
    // a finger coming down stops a flung timeline (before anything under
    // it sees the touch)
    for (const t of [this.scrollEl, this.labelListEl]) {
      t.addEventListener('pointerdown', () => { this._caught = this._stopFling(); }, true);
    }
    // the names column: a swipe over a name, or a touch that stopped the
    // timeline, isn't a tap on it
    this.labelListEl.addEventListener('pointerdown', () => { this._swiped = false; }, true);
    this.labelListEl.addEventListener('click', e => {
      if (!this._swiped && !this._caught) return;
      this._swiped = false;
      this._caught = false;
      e.stopPropagation();
    }, true);
    this._wireSwipe(this.labelListEl, false);
    // mouse / trackpad: sideways (or shift) wheel
    el.addEventListener('wheel', e => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!d) return;
      e.preventDefault();
      el.scrollLeft += d;
    }, { passive: false });
  }

  _stopFling() {
    if (!this._flingRaf) return false;
    cancelAnimationFrame(this._flingRaf);
    this._flingRaf = 0;
    return true;
  }

  // keeps the timeline going after the finger let go, slowing down until
  // it stops (or hits an end). v: scroll speed, px/ms
  _fling(axis, v) {
    this._stopFling();
    if (Math.abs(v) < 0.2) return;
    const el = this.scrollEl;
    const max = axis === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    let pos = axis === 'x' ? el.scrollLeft : el.scrollTop;
    let last = performance.now();
    const step = now => {
      const dt = Math.min(32, now - last);
      last = now;
      pos += v * dt;
      const atEnd = pos <= 0 || pos >= max;
      pos = Math.max(0, Math.min(max, pos));
      if (axis === 'x') {
        el.scrollLeft = pos;
      } else {
        el.scrollTop = pos;
        this.labelListEl.scrollTop = pos;
      }
      v *= FLING_DECAY ** dt;
      if (atEnd || Math.abs(v) < 0.02) {
        this._flingRaf = 0;
        return;
      }
      this._flingRaf = requestAnimationFrame(step);
    };
    this._flingRaf = requestAnimationFrame(step);
  }

  // a scrollbar under the tracks: the thumb shows which part of the
  // animation is in view; drag it to move along, tap the bar to jump there
  _makeScrollbar() {
    const el = this.scrollEl;
    const bar = document.createElement('div');
    bar.className = 'track-scrollbar';
    const thumb = document.createElement('div');
    thumb.className = 'track-scrollbar-thumb';
    bar.appendChild(thumb);
    el.closest('.tracks-container').after(bar);
    this.scrollbarEl = bar;
    this.thumbEl = thumb;

    el.addEventListener('scroll', () => this._updateScrollbar(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this._updateScrollbar());
      ro.observe(el);
      ro.observe(this.innerEl);
    }

    // scroll px per bar px
    const ratio = () => el.scrollWidth / Math.max(1, bar.clientWidth);
    bar.addEventListener('pointerdown', e => {
      e.preventDefault();
      this._stopFling();
      bar.setPointerCapture(e.pointerId);
      const r = thumb.getBoundingClientRect();
      // a tap beside the thumb brings that part into view first
      if (e.clientX < r.left || e.clientX > r.right) {
        const br = bar.getBoundingClientRect();
        el.scrollLeft = (e.clientX - br.left) * ratio() - el.clientWidth / 2;
      }
      const x0 = e.clientX;
      const s0 = el.scrollLeft;
      thumb.classList.add('active');
      const onMove = ev => { el.scrollLeft = s0 + (ev.clientX - x0) * ratio(); };
      const onUp = () => {
        thumb.classList.remove('active');
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        bar.removeEventListener('pointercancel', onUp);
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
      bar.addEventListener('pointercancel', onUp);
    });
  }

  _updateScrollbar() {
    if (!this.thumbEl) return;
    const el = this.scrollEl;
    const w = this.scrollbarEl.clientWidth;
    const total = Math.max(1, el.scrollWidth);
    const thumbW = Math.max(28, Math.min(w, (el.clientWidth / total) * w));
    const maxScroll = el.scrollWidth - el.clientWidth;
    const x = maxScroll > 0 ? (el.scrollLeft / maxScroll) * (w - thumbW) : 0;
    this.thumbEl.style.width = `${thumbW}px`;
    this.thumbEl.style.transform = `translateX(${x}px)`;
    this.scrollbarEl.classList.toggle('idle', maxScroll <= 0);
  }
}

// how fast the finger was moving when it let go (px/ms along the swipe;
// 0 if it had stopped first)
function fingerSpeed(samples, now) {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > 60) return 0;
  const first = samples.find(s => last.t - s.t <= 100) ?? last;
  const dt = last.t - first.t;
  return dt > 0 ? (last.p - first.p) / dt : 0;
}
