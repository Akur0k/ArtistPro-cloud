export function openExportDialog() {
  const overlay = document.getElementById('exportModal');
  const choiceView = document.getElementById('exportChoiceView');
  const progressView = document.getElementById('exportProgressView');
  const pngBtn = document.getElementById('exportPngBtn');
  const pngClearBtn = document.getElementById('exportPngClearBtn');
  const mp4Btn = document.getElementById('exportMp4Btn');
  const backupBtn = document.getElementById('exportBackupBtn');
  const cancelBtn = document.getElementById('exportCancelBtn');

  choiceView.style.display = '';
  progressView.style.display = 'none';
  overlay.classList.add('open');

  return new Promise(resolve => {
    function finish(result) {
      pngBtn.removeEventListener('click', onPng);
      pngClearBtn.removeEventListener('click', onPngClear);
      mp4Btn.removeEventListener('click', onMp4);
      backupBtn.removeEventListener('click', onBackup);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onPng() { finish('png'); }
    function onPngClear() { finish('png-transparent'); }
    function onMp4() { finish('mp4'); }
    function onBackup() { finish('backup'); }
    function onCancel() { overlay.classList.remove('open'); finish(null); }
    pngBtn.addEventListener('click', onPng);
    pngClearBtn.addEventListener('click', onPngClear);
    mp4Btn.addEventListener('click', onMp4);
    backupBtn.addEventListener('click', onBackup);
    cancelBtn.addEventListener('click', onCancel);
  });
}

export function showExportProgress(label) {
  document.getElementById('exportModal').classList.add('open');
  document.getElementById('exportChoiceView').style.display = 'none';
  const progressView = document.getElementById('exportProgressView');
  progressView.style.display = '';
  document.getElementById('exportProgressLabel').textContent = label;
  document.getElementById('exportProgressBar').style.width = '0%';
}

export function updateExportProgress(current, total, label = 'Кодирование…') {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('exportProgressBar').style.width = `${pct}%`;
  document.getElementById('exportProgressLabel').textContent = `${label} ${pct}%`;
}

export function hideExportDialog() {
  document.getElementById('exportModal').classList.remove('open');
}
