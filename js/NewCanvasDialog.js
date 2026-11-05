const PRESETS = [
  { label: 'Телефон', w: 1080, h: 1920 },
  { label: 'Квадрат', w: 2048, h: 2048 },
  { label: 'Альбомная', w: 1920, h: 1080 },
  { label: 'A4', w: 2480, h: 3508 },
];

export function openNewCanvasDialog() {
  const overlay = document.getElementById('newCanvasModal');
  const presetsWrap = document.getElementById('canvasPresets');
  const widthInput = document.getElementById('canvasWidthInput');
  const heightInput = document.getElementById('canvasHeightInput');
  const createBtn = document.getElementById('createCanvasBtn');
  const cancelBtn = document.getElementById('cancelCanvasBtn');

  presetsWrap.innerHTML = '';
  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.textContent = `${preset.label} ${preset.w}×${preset.h}`;
    btn.addEventListener('click', () => {
      widthInput.value = String(preset.w);
      heightInput.value = String(preset.h);
    });
    presetsWrap.appendChild(btn);
  }

  overlay.classList.add('open');

  return new Promise(resolve => {
    function finish(result) {
      createBtn.removeEventListener('click', onCreate);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.classList.remove('open');
      resolve(result);
    }
    function onCreate() {
      const w = Math.min(6000, Math.max(64, Math.round(Number(widthInput.value) || 1080)));
      const h = Math.min(6000, Math.max(64, Math.round(Number(heightInput.value) || 1920)));
      finish({ width: w, height: h });
    }
    function onCancel() {
      finish(null);
    }
    createBtn.addEventListener('click', onCreate);
    cancelBtn.addEventListener('click', onCancel);
  });
}
