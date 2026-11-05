// animation runs at 12 ticks/s; each option samples the video at a rate
// that maps to a whole number of ticks per imported frame
const RATE_OPTIONS = [
  { fps: 12, ticks: 1, label: '12 к/с' },
  { fps: 6, ticks: 2, label: '6 к/с' },
  { fps: 4, ticks: 3, label: '4 к/с' },
];
const DEFAULT_RATE = 1; // 6 fps
const APPROX_FRAME_KB = 300; // typical JPEG frame at ~1080x1920
const WARN_FRAMES = 360;

function fmtSeconds(s) {
  return (Math.round(s * 10) / 10).toFixed(1);
}

// shows the settings view for an opened video; resolves with
// { start, end, fps, ticks, traceMode } or null if cancelled
export function openVideoImportDialog(duration) {
  const overlay = document.getElementById('videoImportModal');
  const settingsView = document.getElementById('videoImportSettings');
  const progressView = document.getElementById('videoImportProgress');
  const startInput = document.getElementById('videoStartInput');
  const endInput = document.getElementById('videoEndInput');
  const ratesWrap = document.getElementById('videoRatePresets');
  const traceInput = document.getElementById('videoTraceInput');
  const estimateEl = document.getElementById('videoImportEstimate');
  const durationEl = document.getElementById('videoImportDuration');
  const okBtn = document.getElementById('videoImportOkBtn');
  const cancelBtn = document.getElementById('videoImportCancelBtn');

  let rate = RATE_OPTIONS[DEFAULT_RATE];

  durationEl.textContent = `Длина видео: ${fmtSeconds(duration)} с`;
  startInput.value = '0';
  startInput.max = String(duration);
  endInput.value = fmtSeconds(duration);
  endInput.max = String(duration);

  const range = () => {
    const start = Math.max(0, Math.min(duration, Number(startInput.value) || 0));
    const end = Math.max(start, Math.min(duration, Number(endInput.value) || duration));
    return { start, end };
  };

  const updateEstimate = () => {
    const { start, end } = range();
    const count = Math.ceil((end - start) * rate.fps - 1e-6);
    const mb = Math.max(1, Math.round((count * APPROX_FRAME_KB) / 1024));
    estimateEl.textContent = `Будет ${count} кадр(ов), ≈ ${mb} МБ в хранилище`;
    estimateEl.classList.toggle('warn', count > WARN_FRAMES);
    okBtn.disabled = count < 1;
  };

  ratesWrap.innerHTML = '';
  for (const opt of RATE_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn' + (opt === rate ? ' selected' : '');
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      rate = opt;
      ratesWrap.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      updateEstimate();
    });
    ratesWrap.appendChild(btn);
  }

  settingsView.style.display = '';
  progressView.style.display = 'none';
  overlay.classList.add('open');
  updateEstimate();

  return new Promise(resolve => {
    function finish(result) {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      startInput.removeEventListener('input', updateEstimate);
      endInput.removeEventListener('input', updateEstimate);
      resolve(result);
    }
    function onOk() {
      const { start, end } = range();
      finish({ start, end, fps: rate.fps, ticks: rate.ticks, traceMode: traceInput.checked });
    }
    function onCancel() {
      overlay.classList.remove('open');
      finish(null);
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    startInput.addEventListener('input', updateEstimate);
    endInput.addEventListener('input', updateEstimate);
  });
}

export function hideVideoImportDialog() {
  document.getElementById('videoImportModal').classList.remove('open');
}

// switches the dialog to its progress view; returns { update, isCancelled, close }
export function showVideoImportProgress() {
  const overlay = document.getElementById('videoImportModal');
  const bar = document.getElementById('videoImportProgressBar');
  const label = document.getElementById('videoImportProgressLabel');
  const stopBtn = document.getElementById('videoImportStopBtn');
  document.getElementById('videoImportSettings').style.display = 'none';
  document.getElementById('videoImportProgress').style.display = '';
  overlay.classList.add('open');
  bar.style.width = '0%';
  label.textContent = 'Импорт… 0%';

  let cancelled = false;
  const onStop = () => { cancelled = true; label.textContent = 'Отмена…'; };
  stopBtn.addEventListener('click', onStop);

  return {
    update(current, total) {
      if (cancelled) return;
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      bar.style.width = `${pct}%`;
      label.textContent = `Импорт… ${current}/${total}`;
    },
    isCancelled: () => cancelled,
    close() {
      stopBtn.removeEventListener('click', onStop);
      overlay.classList.remove('open');
    },
  };
}
