import { listProjects, deleteProject, putProject, detachBlobs } from './Storage.js';
import { openNewCanvasDialog } from './NewCanvasDialog.js';
import { importProjectBackup } from './ProjectBackup.js';
import { setIcon } from './Icons.js';
import {
  serverAvailable, listServerProjects, loadFromServer, serverThumbnail,
  listServerHistory, deleteFromServer, newServerId,
  cloudUser, signInWithGoogle, signInWithEmail, createAccount, resetPassword, signOutCloud,
} from './CloudStore.js';

const homeScreenEl = document.getElementById('homeScreen');
const appEl = document.getElementById('app');
const newProjectBtn = document.getElementById('newProjectBtn');
const importProjectBtn = document.getElementById('importProjectBtn');
const importProjectInput = document.getElementById('importProjectInput');
const projectsGridEl = document.getElementById('projectsGrid');
const projectsEmptyEl = document.getElementById('projectsEmpty');
const homeStatusEl = document.getElementById('homeStatus');
const accountBtn = document.getElementById('accountBtn');
const accountNoteEl = document.getElementById('accountNote');

let activeThumbURLs = [];

function setStatus(text) {
  homeStatusEl.textContent = text || '';
  homeStatusEl.style.display = text ? '' : 'none';
}

function thumbURL(blob) {
  const url = URL.createObjectURL(blob);
  activeThumbURLs.push(url);
  return url;
}

// the next thing done on the home screen: { promise, settle, settled }.
// Cards rendered meanwhile (the phone's list at once, again once the
// cloud's arrives) all report to the same settle
function waitForAction() {
  const wait = { settled: false };
  wait.promise = new Promise(resolve => {
    function settle(action) {
      if (wait.settled) return;
      wait.settled = true;
      newProjectBtn.removeEventListener('click', onNew);
      importProjectBtn.removeEventListener('click', onImportClick);
      importProjectInput.removeEventListener('change', onImportFile);
      accountBtn.removeEventListener('click', onAccount);
      resolve(action);
    }
    function onNew() { settle({ type: 'new' }); }
    function onAccount() { settle({ type: 'account' }); }
    function onImportClick() { importProjectInput.click(); }
    function onImportFile(e) {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) settle({ type: 'import', file });
    }
    newProjectBtn.addEventListener('click', onNew);
    importProjectBtn.addEventListener('click', onImportClick);
    importProjectInput.addEventListener('change', onImportFile);
    accountBtn.addEventListener('click', onAccount);
    wait.settle = settle;
  });
  return wait;
}

// entries: [{ name, updatedAt, local (record) | null, serverId | null,
// thumbnail (Blob) | null }]; online: null while the cloud is still asked
function renderProjects(entries, online, settle) {
  activeThumbURLs.forEach(u => URL.revokeObjectURL(u));
  activeThumbURLs = [];

  projectsGridEl.innerHTML = '';
  projectsEmptyEl.style.display = entries.length === 0 ? '' : 'none';

  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'project-card';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';
    const img = document.createElement('img');
    if (entry.thumbnail) {
      img.src = thumbURL(entry.thumbnail);
      thumbWrap.appendChild(img);
    } else if (entry.serverId && online) {
      serverThumbnail(entry.serverId).then(blob => {
        if (!blob) return;
        img.src = thumbURL(blob);
        thumbWrap.appendChild(img);
      });
    }

    const info = document.createElement('div');
    info.className = 'project-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'project-name';
    nameEl.textContent = entry.name || 'Без названия';
    const dateEl = document.createElement('div');
    dateEl.className = 'project-date';
    dateEl.textContent = new Date(entry.updatedAt).toLocaleDateString('ru-RU');
    const whereEl = document.createElement('div');
    whereEl.className = 'project-where';
    whereEl.textContent = online === null ? '…' : !entry.local ? 'только в облаке' : entry.onServer ? 'есть в облаке' : 'только в телефоне';
    whereEl.classList.toggle('phone-only', online !== null && !entry.onServer);
    info.appendChild(nameEl);
    info.appendChild(dateEl);
    info.appendChild(whereEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'project-delete';
    delBtn.title = 'Удалить';
    setIcon(delBtn, 'x');
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      settle({ type: 'delete', entry });
    });
    const copyBtn = document.createElement('button');
    copyBtn.className = 'project-copy';
    copyBtn.title = 'Копия проекта';
    setIcon(copyBtn, 'copy');
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      settle({ type: 'copy', entry });
    });
    card.appendChild(thumbWrap);
    card.appendChild(info);
    card.appendChild(delBtn);
    card.appendChild(copyBtn);

    // earlier versions, kept in the cloud
    if (entry.onServer && online) {
      const histBtn = document.createElement('button');
      histBtn.className = 'project-history';
      histBtn.title = 'Версии в облаке';
      setIcon(histBtn, 'history');
      histBtn.addEventListener('click', e => {
        e.stopPropagation();
        settle({ type: 'history', entry });
      });
      card.appendChild(histBtn);
    }

    card.addEventListener('click', () => settle({ type: 'open', entry }));
    projectsGridEl.appendChild(card);
  }
}

// the phone's projects (what opens), plus the account's projects in the
// cloud: a phone project saved there gets the versions button; one with no
// project on the phone (deleted there, another phone) is listed too and
// opens from the cloud. Nothing is sent from here.
async function gatherProjects(showLocal) {
  const local = await listProjects();
  const user = await cloudUser();
  accountBtn.classList.toggle('signed-in', Boolean(user));
  accountNoteEl.textContent = user
    ? `Облако: ${user.email || 'вы вошли'}`
    : 'Вы не вошли — проекты сохраняются только в телефоне. Нажмите на значок человечка, чтобы войти.';
  const entry = r => ({ name: r.name, updatedAt: r.updatedAt, local: r, serverId: r.serverId ?? null, onServer: false, thumbnail: r.thumbnail });
  // the phone's own, at once — they open without the cloud
  if (user && navigator.onLine) showLocal(local.map(entry));
  const online = await serverAvailable();
  if (!online) return { entries: local.map(entry), online };
  let remote = [];
  try {
    remote = await listServerProjects();
  } catch {
    remote = [];
  }
  const remoteIds = new Set(remote.map(p => p.id));
  const entries = local.map(r => ({ ...entry(r), onServer: Boolean(r.serverId && remoteIds.has(r.serverId)) }));
  const localIds = new Set(local.map(r => r.serverId).filter(Boolean));
  for (const p of remote) {
    if (localIds.has(p.id)) continue;
    entries.push({ name: p.name, updatedAt: p.updatedAt, local: null, serverId: p.id, onServer: true, thumbnail: null });
  }
  entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { entries, online };
}

// a list of the cloud's earlier versions of a project; resolves to the
// chosen one's name, or null
function pickVersion(entry, versions) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'versions-backdrop';
    const box = document.createElement('div');
    box.className = 'versions-dialog';
    const title = document.createElement('div');
    title.className = 'versions-title';
    title.textContent = `«${entry.name || 'Без названия'}»: версии в облаке`;
    box.appendChild(title);
    const list = document.createElement('div');
    list.className = 'versions-list';
    if (!versions.length) {
      const empty = document.createElement('div');
      empty.className = 'versions-empty';
      empty.textContent = 'Версий пока нет';
      list.appendChild(empty);
    }
    const close = v => {
      backdrop.remove();
      resolve(v);
    };
    for (const v of versions) {
      const b = document.createElement('button');
      b.className = 'versions-item';
      b.textContent = v.date
        ? v.date.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : v.name;
      b.addEventListener('click', () => close(v.name));
      list.appendChild(b);
    }
    box.appendChild(list);
    const cancel = document.createElement('button');
    cancel.className = 'versions-cancel';
    cancel.textContent = 'Отмена';
    cancel.addEventListener('click', () => close(null));
    box.appendChild(cancel);
    backdrop.appendChild(box);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(null); });
    document.body.appendChild(backdrop);
  });
}

// signing in / out of the cloud; resolves once the dialog is closed
async function accountDialog() {
  const user = await cloudUser();
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'versions-backdrop';
    const box = document.createElement('div');
    box.className = 'versions-dialog account-dialog';
    const close = () => {
      backdrop.remove();
      resolve();
    };
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      box.appendChild(e);
      return e;
    };
    const message = () => {
      const m = el('div', 'account-message');
      return text => { m.textContent = text || ''; };
    };
    // runs a sign-in step with the buttons locked; closes on success
    const busy = (buttons, say) => async fn => {
      buttons.forEach(b => { b.disabled = true; });
      say('Подождите…');
      try {
        await fn();
        close();
      } catch (e) {
        say(e.message);
      } finally {
        buttons.forEach(b => { b.disabled = false; });
      }
    };

    if (user) {
      el('div', 'versions-title', 'Аккаунт');
      el('div', 'account-email', user.email || 'вы вошли');
      el('div', 'versions-empty', 'Кнопка «Сохранить» в проекте отправляет его в облако этого аккаунта.');
      const out = el('button', 'versions-item account-main', 'Выйти');
      const say = message();
      const cancel = el('button', 'versions-cancel', 'Закрыть');
      out.addEventListener('click', () => busy([out], say)(signOutCloud));
      cancel.addEventListener('click', close);
    } else {
      el('div', 'versions-title', 'Вход в облако');
      el('div', 'versions-empty', 'Войдите, чтобы сохранять проекты в облако и открывать их на любом устройстве.');
      const google = el('button', 'versions-item account-main', 'Войти через Google');
      el('div', 'account-or', 'или по почте');
      const email = el('input', 'account-input');
      email.type = 'email';
      email.placeholder = 'Почта';
      email.autocomplete = 'email';
      const password = el('input', 'account-input');
      password.type = 'password';
      password.placeholder = 'Пароль (не меньше 6 символов)';
      password.autocomplete = 'current-password';
      const signIn = el('button', 'versions-item account-main', 'Войти');
      const create = el('button', 'versions-item', 'Создать аккаунт');
      const forgot = el('button', 'versions-item', 'Забыл пароль');
      const say = message();
      const cancel = el('button', 'versions-cancel', 'Отмена');
      // (not Отмена: a sign-in window left hanging must not lock the dialog)
      const all = [google, signIn, create, forgot];
      const run = busy(all, say);
      google.addEventListener('click', () => run(signInWithGoogle));
      signIn.addEventListener('click', () => run(() => signInWithEmail(email.value.trim(), password.value)));
      create.addEventListener('click', () => run(() => createAccount(email.value.trim(), password.value)));
      forgot.addEventListener('click', async () => {
        all.forEach(b => { b.disabled = true; });
        try {
          await resetPassword(email.value.trim());
          say('Письмо для смены пароля отправлено на почту');
        } catch (e) {
          say(e.message);
        } finally {
          all.forEach(b => { b.disabled = false; });
        }
      });
      cancel.addEventListener('click', close);
    }
    backdrop.appendChild(box);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);
  });
}

// the project to open, as a record
async function loadEntry(entry, snapshot = null) {
  if (entry.local && !snapshot) return entry.local;
  setStatus('Загружаю проект из облака…');
  try {
    const record = await loadFromServer(entry.serverId, snapshot);
    // a version of a project that's on the phone opens as a copy of its own
    // (the phone's project stays as it is), saved to the cloud on its own
    if (entry.local) {
      record.serverId = newServerId();
      const when = new Date(record.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
      record.name = `${record.name || 'Без названия'} (версия ${when})`;
    }
    return record;
  } finally {
    setStatus('');
  }
}

// a new project on the phone with the same contents (from the cloud's
// latest version when the phone has none) — its own name and place in the cloud,
// the original stays as it is
async function copyProject(entry) {
  const source = entry.local ?? await loadEntry(entry);
  const record = { ...source, layers: structuredClone(source.layers) };
  // Safari's stored pictures are references into the original's record —
  // the copy needs its own
  await detachBlobs(record);
  delete record.id;
  record.serverId = newServerId();
  record.name = `${source.name || 'Без названия'} (копия)`;
  record.updatedAt = Date.now();
  await putProject(record);
}

export async function showHomeScreen() {
  homeScreenEl.style.display = '';
  appEl.style.display = 'none';

  for (;;) {
    const wait = waitForAction();
    const show = (entries, online) => {
      if (!wait.settled) renderProjects(entries, online, wait.settle);
    };
    gatherProjects(entries => show(entries, null))
      .then(({ entries, online }) => show(entries, online))
      .catch(e => setStatus('Не удалось получить список проектов: ' + e.message));
    const action = await wait.promise;

    if (action.type === 'delete') {
      const { entry } = action;
      // a phone project: only the phone's copy goes (it stays in the
      // cloud); a cloud-only entry: the cloud's, with all its versions
      if (entry.local) {
        if (!confirm(`Удалить проект «${entry.name || 'Без названия'}» с телефона?${entry.onServer ? ' В облаке он останется.' : ''}`)) continue;
        await deleteProject(entry.local.id);
      } else {
        if (!confirm(`Удалить проект «${entry.name || 'Без названия'}» из облака вместе со всеми версиями? Это не отменить.`)) continue;
        setStatus('Удаляю из облака…');
        await deleteFromServer(entry.serverId).catch(e => alert('Не удалось удалить из облака: ' + e.message));
        setStatus('');
      }
      continue;
    }
    if (action.type === 'account') {
      await accountDialog();
      continue;
    }
    if (action.type === 'copy') {
      try {
        await copyProject(action.entry);
      } catch (e) {
        alert('Не удалось скопировать проект: ' + e.message);
      }
      continue;
    }
    if (action.type === 'import') {
      try {
        const record = await importProjectBackup(action.file);
        await putProject(record);
      } catch (e) {
        alert('Не удалось импортировать бэкап: ' + e.message);
      }
      continue;
    }
    if (action.type === 'new') {
      const result = await openNewCanvasDialog();
      if (!result) continue;
      homeScreenEl.style.display = 'none';
      appEl.style.display = '';
      return { mode: 'new', width: result.width, height: result.height };
    }

    let snapshot = null;
    if (action.type === 'history') {
      let versions = [];
      try {
        versions = await listServerHistory(action.entry.serverId);
      } catch (e) {
        alert('Не удалось получить версии: ' + e.message);
        continue;
      }
      snapshot = await pickVersion(action.entry, versions);
      if (!snapshot) continue;
    }
    let project;
    try {
      project = await loadEntry(action.entry, snapshot);
    } catch (e) {
      alert('Не удалось открыть проект: ' + e.message);
      continue;
    }
    homeScreenEl.style.display = 'none';
    appEl.style.display = '';
    return { mode: 'open', project };
  }
}
