import { Layer } from './Layer.js';
import { ObjectLayer } from './ObjectLayer.js';
import { setKeepProvider, invalidateDisplay } from './Frame.js';

// mirrors CSS background-size:cover — scales img to fill dw x dh, cropping
// whichever axis overflows, centered. Keeps the offscreen export/thumbnail
// compositing visually consistent with what background-image:cover shows
// in the live editor.
export function drawImageCover(ctx, img, dw, dh) {
  const iw = img.width, ih = img.height;
  if (!iw || !ih) return;
  const scale = Math.max(dw / iw, dh / ih);
  const sw = dw / scale, sh = dh / scale;
  const sx = (iw - sw) / 2, sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
}

export class LayerManager {
  constructor(containerEl) {
    this.container = containerEl;
    this.layers = [];
    this.activeIndex = -1;
    this.playhead = 0; // global time position, in ticks
    // where the animation ends (ticks), set by the end marker on the
    // timeline; null: where the longest visible layer ends
    this.endTime = null;
    this.backgroundColor = '#ffffff';
    this.backgroundMode = 'color'; // 'color' | 'image'
    this.backgroundImageBlob = null;
    this.backgroundImageBitmap = null;
    this.playing = false;
    this.onion = false; // onion skin on: neighbours of the current frames stay decoded
    // layers' colors (Layer.tint) shown — a mode, like onion skin
    this.tintsShown = true;
    // (layer, frame) — an encoded frame finished decoding and can be shown
    this.onFrameReady = null;
    // (a kept frame keeps its fill borders too)
    setKeepProvider(() => this.layers.flatMap(l => l.keepFrames(this.playing, this.onion)).flatMap(f => (f.guide ? [f, f.guide] : [f])));
  }

  // the background isn't a real layer (doesn't show in the layers panel,
  // can't be hidden/reordered/deleted) — just always-present color or image
  // painted behind the whole stack, inside the camera (Display draws it on
  // screen; drawBackgroundOnto() for export / thumbnails).
  setBackgroundColor(color) {
    this.backgroundMode = 'color';
    this.backgroundColor = color;
    this.backgroundImageBlob = null;
    this.backgroundImageBitmap = null;
    invalidateDisplay();
  }

  async setBackgroundImage(blob) {
    const bitmap = await createImageBitmap(blob);
    this.backgroundMode = 'image';
    this.backgroundImageBlob = blob;
    this.backgroundImageBitmap = bitmap;
    invalidateDisplay();
  }

  drawBackgroundOnto(ctx, width, height) {
    if (this.backgroundMode === 'image' && this.backgroundImageBitmap) {
      drawImageCover(ctx, this.backgroundImageBitmap, width, height);
    } else {
      ctx.fillStyle = this.backgroundColor || '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
  }

  get width() {
    return this.container.clientWidth;
  }

  get height() {
    return this.container.clientHeight;
  }

  // the color a layer shows in right now (null: its own colors)
  tintOf(layer) {
    return this.tintsShown ? layer.tint : null;
  }

  get activeLayer() {
    return this.layers[this.activeIndex] ?? null;
  }

  // where the longest visible layer ends — a hidden layer doesn't make the
  // animation longer
  get autoDuration() {
    const shown = this.layers.filter(l => l.visible);
    return (shown.length ? shown : this.layers).reduce((max, l) => Math.max(max, l.totalDuration), 1);
  }

  // how long the animation is: what plays (and loops) and what's exported
  get totalDuration() {
    return this.endTime ?? this.autoDuration;
  }

  // what the timeline spans: the animation, and any frames past its end
  get timelineLength() {
    return this.layers.reduce((max, l) => Math.max(max, l.totalDuration), this.totalDuration);
  }

  getLayer(id) {
    return this.layers.find(l => l.id === id) ?? null;
  }

  // atBottom: insert under every existing layer (imported video, meant to
  // be traced over) instead of on top; above: right over that layer
  addLayer(name, { encoding = 'png', atBottom = false, above = null } = {}) {
    const layer = new Layer(this.width, this.height, name, { encoding });
    layer.onFrameReady = (l, frame) => this.onFrameReady?.(l, frame);
    layer.syncToTime(this.playhead);
    const aboveIndex = above ? this.layers.indexOf(above) : -1;
    if (atBottom) {
      this.layers.unshift(layer);
      this.activeIndex = 0;
    } else if (aboveIndex !== -1) {
      this.layers.splice(aboveIndex + 1, 0, layer);
      this.activeIndex = aboveIndex + 1;
    } else {
      this.layers.push(layer);
      this.activeIndex = this.layers.length - 1;
    }
    invalidateDisplay();
    return layer;
  }

  // a moving object (ObjectLayer): { piece, keys }, right over `above`
  addObjectLayer(name, data, { above = null } = {}) {
    const layer = new ObjectLayer(this.width, this.height, name, data);
    layer.syncToTime(this.playhead);
    const aboveIndex = above ? this.layers.indexOf(above) : -1;
    if (aboveIndex !== -1) {
      this.layers.splice(aboveIndex + 1, 0, layer);
      this.activeIndex = aboveIndex + 1;
    } else {
      this.layers.push(layer);
      this.activeIndex = this.layers.length - 1;
    }
    invalidateDisplay();
    return layer;
  }

  removeLayer(id) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx === -1 || this.layers.length <= 1) return;
    const activeId = this.activeLayer?.id;
    const [layer] = this.layers.splice(idx, 1);
    layer.release();
    invalidateDisplay();
    // keep the same layer active (its index shifts if one below it went);
    // if the active one itself was deleted, the one that took its place
    if (activeId !== id) this.setActive(activeId);
    else this.activeIndex = Math.min(idx, this.layers.length - 1);
  }

  setActive(id) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx !== -1) this.activeIndex = idx;
  }

  // puts the layer at position toIndex (0 = bottom), the active one staying active
  moveLayer(id, toIndex) {
    const from = this.layers.findIndex(l => l.id === id);
    if (from === -1) return;
    const to = Math.max(0, Math.min(this.layers.length - 1, toIndex));
    if (to === from) return;
    const activeId = this.activeLayer?.id;
    const [layer] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, layer);
    if (activeId !== undefined) this.setActive(activeId);
    invalidateDisplay();
  }

  moveUp(id) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx === -1 || idx === this.layers.length - 1) return;
    const activeId = this.activeLayer?.id;
    [this.layers[idx], this.layers[idx + 1]] = [this.layers[idx + 1], this.layers[idx]];
    this._syncDomOrder();
    if (activeId !== undefined) this.setActive(activeId);
  }

  moveDown(id) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx <= 0) return;
    const activeId = this.activeLayer?.id;
    [this.layers[idx], this.layers[idx - 1]] = [this.layers[idx - 1], this.layers[idx]];
    this._syncDomOrder();
    if (activeId !== undefined) this.setActive(activeId);
  }

  _syncDomOrder() {
    invalidateDisplay();
  }

  setPlayhead(t) {
    const total = this.timelineLength;
    this.playhead = total > 0 ? ((t % total) + total) % total : 0;
    for (const layer of this.layers) {
      layer.syncToTime(this.playhead);
      layer.prefetch(this.playing, this.onion);
    }
  }
}
