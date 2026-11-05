// unlike TweenDialog/ExportDialog (single choice, one Promise), this modal
// applies changes live as the user picks — color updates immediately,
// picking an image from the gallery applies immediately — since there's no
// single "confirm" action that makes sense for a background preview. The
// caller supplies layerManager directly and an onChange hook (for saving).
export function openBackgroundDialog({ layerManager, onChange }) {
  const overlay = document.getElementById('backgroundModal');
  const colorInput = document.getElementById('bgColorInput');
  const pickImageBtn = document.getElementById('bgPickImageBtn');
  const resetBtn = document.getElementById('bgResetBtn');
  const fileInput = document.getElementById('bgImageFileInput');
  const doneBtn = document.getElementById('bgDoneBtn');

  colorInput.value = layerManager.backgroundColor || '#ffffff';
  overlay.classList.add('open');

  function onColorInput(e) {
    layerManager.setBackgroundColor(e.target.value);
    onChange?.();
  }

  function onPickImage() {
    fileInput.click();
  }

  async function onFileChange(e) {
    const file = e.target.files[0];
    fileInput.value = '';
    if (!file) return;
    await layerManager.setBackgroundImage(file);
    onChange?.();
  }

  function onReset() {
    layerManager.setBackgroundColor('#ffffff');
    colorInput.value = '#ffffff';
    onChange?.();
  }

  function onDone() {
    overlay.classList.remove('open');
    colorInput.removeEventListener('input', onColorInput);
    pickImageBtn.removeEventListener('click', onPickImage);
    fileInput.removeEventListener('change', onFileChange);
    resetBtn.removeEventListener('click', onReset);
    doneBtn.removeEventListener('click', onDone);
  }

  colorInput.addEventListener('input', onColorInput);
  pickImageBtn.addEventListener('click', onPickImage);
  fileInput.addEventListener('change', onFileChange);
  resetBtn.addEventListener('click', onReset);
  doneBtn.addEventListener('click', onDone);
}
