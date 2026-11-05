import { readFrameImage, drawFrameImage } from './Frame.js';
import { setIcon } from './Icons.js';

// a layer's color, one tap: blue, red, green, orange
const TINT_PRESETS = ['#2563eb', '#e11d48', '#16a34a', '#f59e0b'];

export class LayersPanel {
  // onChange: anything changed (opacity drags call it continuously);
  // onStructureChange: layers added / removed / reordered;
  // onBeforeRemove(layer): about to delete that layer;
  // onMerge(layer): merge that layer into the one under it
  // onTintChange: a layer's color was chosen or taken off
  constructor(layerManager, listEl, { onChange, onStructureChange, onBeforeRemove, onMerge, onTintChange } = {}) {
    this.layerManager = layerManager;
    this.listEl = listEl;
    this.onChange = onChange ?? (() => {});
    this.onStructureChange = onStructureChange ?? (() => {});
    this.onBeforeRemove = onBeforeRemove ?? (() => {});
    this.onMerge = onMerge ?? (() => {});
    this.onTintChange = onTintChange ?? (() => {});
  }

  refreshThumbnail(layer) {
    const thumb = layer._thumbEl;
    if (!thumb) return;
    const tctx = thumb.getContext('2d');
    // an object layer: its picture, fitted
    if (layer.kind === 'object') {
      layer.ready().then(() => {
        const { canvas, w, h } = layer.piece;
        const k = Math.min(thumb.width / w, thumb.height / h) * 0.9;
        tctx.clearRect(0, 0, thumb.width, thumb.height);
        const tint = this.layerManager.tintOf(layer);
        tctx.drawImage(canvas, (thumb.width - w * k) / 2, (thumb.height - h * k) / 2, w * k, h * k);
        if (tint) {
          tctx.globalCompositeOperation = 'source-in';
          tctx.fillStyle = tint;
          tctx.fillRect(0, 0, thumb.width, thumb.height);
          tctx.globalCompositeOperation = 'source-over';
        }
      }).catch(() => {});
      return;
    }
    const token = {};
    thumb._thumbToken = token;
    readFrameImage(layer.currentFrame, thumb.width).then(src => {
      if (thumb._thumbToken !== token) {
        src?.release();
        return;
      }
      tctx.clearRect(0, 0, thumb.width, thumb.height);
      if (src) {
        drawFrameImage(tctx, src, thumb.width, thumb.height, layer.tint);
        src.release();
      }
    }).catch(() => {});
  }

  // dragging a row by its grip: the others make room as it passes them;
  // on release the layer moves to where the gap is
  _wireDrag(grip, row, layer) {
    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const layers = this.layerManager.layers;
      const from = layers.indexOf(layer);
      const rows = layers.map(l => l._rowEl);
      const step = row.offsetHeight + 6; // row + the list's gap
      const centers = rows.map(r => {
        const b = r.getBoundingClientRect();
        return b.top + b.height / 2;
      });
      const startY = e.clientY;
      let to = from;
      row.classList.add('dragging');

      const onMove = ev => {
        const dy = ev.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        // the layer goes above every other row whose middle it's above
        // (the list shows the top layer first)
        const y = centers[from] + dy;
        to = 0;
        for (let i = 0; i < rows.length; i++) if (i !== from && centers[i] > y) to++;
        rows.forEach((r, i) => {
          if (i === from) return;
          let shift = 0;
          if (from < to && i > from && i <= to) shift = step; // moving up: these slide down
          if (to < from && i >= to && i < from) shift = -step; // moving down: these slide up
          r.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const onUp = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onUp);
        rows.forEach(r => { r.style.transform = ''; });
        row.classList.remove('dragging');
        if (to !== from) {
          this.layerManager.moveLayer(layer.id, to);
          this.render();
          this.onStructureChange();
          this.onChange();
        }
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onUp);
    });
  }

  render() {
    const layers = this.layerManager.layers;
    this.listEl.innerHTML = '';

    for (const layer of layers) {
      const row = document.createElement('div');
      row.className = 'layer-row' + (layer === this.layerManager.activeLayer ? ' active' : '');
      layer._rowEl = row;

      const thumbEl = document.createElement('canvas');
      thumbEl.className = 'thumb';
      thumbEl.width = 80;
      thumbEl.height = 80;
      layer._thumbEl = thumbEl;
      this.refreshThumbnail(layer);

      const main = document.createElement('div');
      main.className = 'layer-main';

      const nameEl = document.createElement('div');
      nameEl.className = 'layer-name';
      nameEl.textContent = layer.name;

      const opacitySlider = document.createElement('input');
      opacitySlider.type = 'range';
      opacitySlider.min = '0';
      opacitySlider.max = '100';
      opacitySlider.value = String(Math.round(layer.opacity * 100));
      opacitySlider.addEventListener('input', e => {
        layer.opacity = Number(e.target.value) / 100;
        layer.applyVisualState();
        this.onChange();
      });
      opacitySlider.addEventListener('pointerdown', e => e.stopPropagation());

      // the layer's color: everything on it shows in this one color on
      // screen (not in exports); ✕ — its own colors again
      const tintRow = document.createElement('div');
      tintRow.className = 'layer-tint' + (layer.tint ? ' on' : '');
      const tintInput = document.createElement('input');
      tintInput.type = 'color';
      tintInput.title = 'Цвет слоя';
      tintInput.value = layer.tint || layer._lastTint || '#2563eb';
      const tintOff = document.createElement('button');
      tintOff.className = 'layer-tint-off';
      tintOff.title = 'Убрать цвет слоя';
      setIcon(tintOff, 'x');
      tintOff.style.display = layer.tint ? '' : 'none';
      const setTint = (tint, done) => {
        layer.tint = tint;
        if (tint) layer._lastTint = tint;
        layer.applyVisualState();
        if (done) {
          this.render();
          this.onTintChange(layer);
        }
      };
      for (const el of [tintInput, tintOff]) {
        el.addEventListener('click', e => e.stopPropagation());
        el.addEventListener('pointerdown', e => e.stopPropagation());
      }
      tintInput.addEventListener('input', () => setTint(tintInput.value, false));
      tintInput.addEventListener('change', () => setTint(tintInput.value, true));
      tintOff.addEventListener('click', () => setTint(null, true));
      for (const c of TINT_PRESETS) {
        const b = document.createElement('button');
        b.className = 'layer-tint-preset' + (layer.tint === c ? ' chosen' : '');
        b.style.background = c;
        b.title = 'Цвет слоя';
        b.addEventListener('click', e => {
          e.stopPropagation();
          setTint(c, true);
        });
        b.addEventListener('pointerdown', e => e.stopPropagation());
        tintRow.appendChild(b);
      }
      // any other color
      if (layer.tint && !TINT_PRESETS.includes(layer.tint)) tintInput.classList.add('chosen');
      tintRow.appendChild(tintInput);
      tintRow.appendChild(tintOff);

      main.appendChild(nameEl);
      main.appendChild(opacitySlider);

      const controls = document.createElement('div');
      controls.className = 'layer-controls';

      const visBtn = document.createElement('button');
      setIcon(visBtn, layer.visible ? 'eye' : 'eye-off');
      visBtn.className = 'vis-btn' + (layer.visible ? '' : ' hidden-layer');
      visBtn.addEventListener('click', e => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        layer.applyVisualState();
        this.render();
        this.onStructureChange(); // the timeline shows visibility too
        this.onChange();
      });

      const delBtn = document.createElement('button');
      setIcon(delBtn, 'trash-2');
      delBtn.title = 'Удалить слой';
      delBtn.disabled = layers.length <= 1;
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (layers.length <= 1) return;
        this.onBeforeRemove(layer);
        this.layerManager.removeLayer(layer.id);
        this.render();
        this.onStructureChange();
        this.onChange();
      });

      // into the layer below — not for the bottom one, nor with a hidden
      // one involved (what would it look like?)
      const below = layers[layers.indexOf(layer) - 1];
      const mergeBtn = document.createElement('button');
      setIcon(mergeBtn, 'merge');
      mergeBtn.title = 'Объединить со слоем ниже';
      mergeBtn.disabled = !below || !layer.visible || !below.visible || layer.kind === 'object' || below.kind === 'object';
      mergeBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (!mergeBtn.disabled) this.onMerge(layer);
      });

      controls.appendChild(visBtn);
      controls.appendChild(mergeBtn);
      controls.appendChild(delBtn);

      row.addEventListener('click', () => {
        this.layerManager.setActive(layer.id);
        this.render();
        this.onChange();
      });

      // drag handle: pull the row up / down to restack the layer
      const grip = document.createElement('div');
      grip.className = 'layer-grip';
      grip.title = 'Перетащите, чтобы поменять порядок';
      setIcon(grip, 'grip-vertical');
      this._wireDrag(grip, row, layer);

      row.appendChild(grip);
      row.appendChild(thumbEl);
      row.appendChild(main);
      row.appendChild(controls);
      // a line of its own under the rest (too wide beside it on a phone)
      row.appendChild(tintRow);
      this.listEl.appendChild(row);
    }
  }
}
