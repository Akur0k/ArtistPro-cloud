// Projects in the cloud (Firebase: sign-in + Firestore), one account each.
// The project itself lives on the phone (Storage.js, IndexedDB); it's sent
// only when the save button is pressed, and each save is kept as a version.
//
// Everything is in Firestore — the free plan has no file storage — so a
// picture is a document of bytes, split over several when it's bigger than
// a document may be:
//
//   users/{uid}/projects/{id}                 name, updatedAt, json, thumb
//   users/{uid}/projects/{id}/files/{name}    data (bytes), type, parts
//   users/{uid}/projects/{id}/files/{name}~1  data — the rest of a big one
//   users/{uid}/projects/{id}/meta/files      parts: { name: count } — what's there
//   users/{uid}/projects/{id}/versions/{v}    savedAt, json, thumb
//
// A file is named after a hash of its content (ProjectFormat), so a save
// sends only the pictures that aren't up there yet. Nobody can read or
// write anyone else's: see firestore.rules.

import { recordToDisk, diskToRecord, fileNameFor } from './ProjectFormat.js';
import { blobKey } from './BlobKey.js';
import { firebaseConfig } from './firebaseConfig.js';

// a document holds at most 1 MiB; a batch of writes at most 10 MiB / 500
const CHUNK = 900 * 1024;
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_OPS = 400;

let sdk = null;
// the Firebase SDK (local copy in js/vendor) — loaded the first time it's needed
function load() {
  sdk ??= (async () => {
    const [app, auth, fs] = await Promise.all([
      import('./vendor/firebase/firebase-app.js'),
      import('./vendor/firebase/firebase-auth.js'),
      import('./vendor/firebase/firebase-firestore-lite.js'),
    ]);
    const firebaseApp = app.initializeApp(firebaseConfig);
    const a = auth.getAuth(firebaseApp);
    a.languageCode = 'ru';
    await a.authStateReady();
    return { auth, a, fs, db: fs.getFirestore(firebaseApp) };
  })();
  sdk.catch(() => { sdk = null; }); // offline the first time: try again later
  return sdk;
}

// ---- the account ----

// { uid, email } or null; waits for the saved sign-in to be restored
export async function cloudUser() {
  try {
    const { a } = await load();
    return a.currentUser ? { uid: a.currentUser.uid, email: a.currentUser.email } : null;
  } catch {
    return null;
  }
}

// Russian for what Firebase says went wrong
function authError(e) {
  const code = String(e?.code || '');
  const known = {
    'auth/invalid-email': 'Неверный адрес почты',
    'auth/missing-password': 'Введите пароль',
    'auth/weak-password': 'Пароль слишком простой — нужно хотя бы 6 символов',
    'auth/email-already-in-use': 'Такой аккаунт уже есть — нажмите «Войти»',
    'auth/invalid-credential': 'Неверная почта или пароль',
    'auth/wrong-password': 'Неверная почта или пароль',
    'auth/user-not-found': 'Такого аккаунта нет — нажмите «Создать аккаунт»',
    'auth/too-many-requests': 'Слишком много попыток — подождите немного',
    'auth/network-request-failed': 'Нет интернета',
    'auth/popup-blocked': 'Браузер не дал открыть окно входа',
    'auth/popup-closed-by-user': 'Окно входа закрыто',
    'auth/cancelled-popup-request': 'Окно входа закрыто',
    'auth/unauthorized-domain': 'Этот адрес сайта не разрешён в настройках Firebase (Authentication → Settings → Authorized domains)',
    'auth/operation-not-allowed': 'Этот способ входа не включён в Firebase',
  };
  return new Error(known[code] || e?.message || String(e));
}

async function authCall(fn) {
  const { auth, a } = await load();
  try {
    await fn(auth, a);
  } catch (e) {
    throw authError(e);
  }
}

export const signInWithGoogle = () => authCall((auth, a) => auth.signInWithPopup(a, new auth.GoogleAuthProvider()));
export const signInWithEmail = (email, password) => authCall((auth, a) => auth.signInWithEmailAndPassword(a, email, password));
export const createAccount = (email, password) => authCall((auth, a) => auth.createUserWithEmailAndPassword(a, email, password));
export const resetPassword = email => authCall((auth, a) => auth.sendPasswordResetEmail(a, email));
export const signOutCloud = () => authCall((auth, a) => auth.signOut(a));

// ---- projects ----

// signed in and online
export async function serverAvailable() {
  if (!navigator.onLine) return false;
  return Boolean(await cloudUser());
}

export function newServerId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function ctx() {
  const s = await load();
  const user = s.a.currentUser;
  if (!user) throw new Error('вы не вошли в аккаунт');
  const { fs, db } = s;
  const project = id => fs.doc(db, 'users', user.uid, 'projects', id);
  return {
    fs,
    db,
    projects: () => fs.collection(db, 'users', user.uid, 'projects'),
    project,
    file: (id, name) => fs.doc(project(id), 'files', name),
    manifest: id => fs.doc(project(id), 'meta', 'files'),
    versions: id => fs.collection(project(id), 'versions'),
    version: (id, v) => fs.doc(project(id), 'versions', v),
  };
}

// writes, a batch at a time (Firestore caps a batch's size and count)
function batcher(c) {
  let batch = c.fs.writeBatch(c.db);
  let ops = 0;
  let bytes = 0;
  const commit = async () => {
    if (!ops) return;
    const b = batch;
    batch = c.fs.writeBatch(c.db);
    ops = 0;
    bytes = 0;
    await b.commit();
  };
  return {
    async set(ref, data, size = 200, options) {
      if (ops && (ops >= BATCH_OPS || bytes + size > BATCH_BYTES)) await commit();
      if (options) batch.set(ref, data, options);
      else batch.set(ref, data);
      ops++;
      bytes += size;
    },
    async delete(ref) {
      if (ops >= BATCH_OPS) await commit();
      batch.delete(ref);
      ops++;
    },
    commit,
  };
}

// what's up there already, per project — not sent again
const known = new Map(); // id -> Map(name -> parts)

async function knownFiles(c, id) {
  if (!known.has(id)) {
    const snap = await c.fs.getDoc(c.manifest(id));
    known.set(id, new Map(Object.entries(snap.exists() ? snap.data().parts ?? {} : {})));
  }
  return known.get(id);
}

async function putFile(w, c, id, name, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let i = 0; i < parts; i++) {
    const data = c.fs.Bytes.fromUint8Array(bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
    const ref = c.file(id, i ? `${name}~${i}` : name);
    await w.set(ref, i ? { data } : { data, type: blob.type || 'application/octet-stream', parts }, Math.min(CHUNK, bytes.length - i * CHUNK) + 200);
  }
  return parts;
}

async function getFile(c, id, name) {
  const first = await c.fs.getDoc(c.file(id, name));
  if (!first.exists()) throw new Error(`в облаке нет файла ${name}`);
  const { data, type, parts = 1 } = first.data();
  const chunks = [data.toUint8Array()];
  for (let i = 1; i < parts; i++) {
    const snap = await c.fs.getDoc(c.file(id, `${name}~${i}`));
    if (!snap.exists()) throw new Error(`в облаке нет части файла ${name}`);
    chunks.push(snap.data().data.toUint8Array());
  }
  return new Blob(chunks, { type });
}

function versionId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

// record: what doSave() builds; record.serverId names the project.
// Gives up (throws) after timeoutMs — a stalled connection must not leave
// the save button spinning forever (what was sent by then stays)
export async function saveToServer(record, { timeoutMs = 120000 } = {}) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('облако не ответило вовремя')), timeoutMs);
  });
  try {
    await Promise.race([send(record), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function send(record) {
  const c = await ctx();
  const id = record.serverId;
  const { json, files } = await recordToDisk(record);
  // the thumbnail by its content too: a new one per picture, an old version keeps its own
  let thumb = null;
  if (files.has('thumb.png')) {
    const blob = files.get('thumb.png');
    files.delete('thumb.png');
    thumb = await fileNameFor(blob);
    files.set(thumb, blob);
    json.thumbnail = thumb;
  }
  const jsonBlob = new Blob([JSON.stringify(json)], { type: 'application/json' });
  const jsonName = `${await blobKey(jsonBlob)}.json`;
  files.set(jsonName, jsonBlob);

  const have = await knownFiles(c, id);
  const w = batcher(c);
  const added = {};
  for (const [name, blob] of files) {
    if (have.has(name)) continue;
    added[name] = await putFile(w, c, id, name, blob);
  }
  // the pictures first, then what points at them: a save cut off halfway
  // leaves the last complete version as it was
  await w.commit();
  const savedAt = Date.now();
  await w.set(c.manifest(id), { parts: added }, 200 + 40 * Object.keys(added).length, { merge: true });
  await w.set(c.version(id, versionId()), { savedAt, json: jsonName, thumb });
  await w.set(c.project(id), { name: record.name || 'Без названия', updatedAt: record.updatedAt ?? savedAt, savedAt, json: jsonName, thumb });
  await w.commit();
  for (const [name, parts] of Object.entries(added)) have.set(name, parts);
}

const thumbs = new Map(); // id -> thumbnail file name, from the last listing

// [{ id, name, updatedAt }]
export async function listServerProjects() {
  const c = await ctx();
  const snap = await c.fs.getDocs(c.projects());
  return snap.docs.map(d => {
    const p = d.data();
    thumbs.set(d.id, p.thumb ?? null);
    return { id: d.id, name: p.name, updatedAt: p.updatedAt ?? p.savedAt ?? 0 };
  });
}

// the project as the app's record (snapshot: a version's name)
export async function loadFromServer(id, snapshot = null) {
  const c = await ctx();
  const head = await c.fs.getDoc(snapshot ? c.version(id, snapshot) : c.project(id));
  if (!head.exists()) throw new Error('проекта нет в облаке');
  const json = JSON.parse(await (await getFile(c, id, head.data().json)).text());
  // the pictures, a few at a time
  const queue = [];
  let running = 0;
  const limited = name => new Promise((resolve, reject) => {
    queue.push({ name, resolve, reject });
    pump();
  });
  function pump() {
    while (running < 8 && queue.length) {
      const job = queue.shift();
      running++;
      getFile(c, id, job.name).then(job.resolve, job.reject).finally(() => {
        running--;
        pump();
      });
    }
  }
  const record = await diskToRecord(json, limited);
  record.serverId = id;
  return record;
}

export async function serverThumbnail(id) {
  try {
    const c = await ctx();
    let name = thumbs.get(id);
    if (name === undefined) {
      const snap = await c.fs.getDoc(c.project(id));
      name = snap.exists() ? snap.data().thumb ?? null : null;
    }
    return name ? await getFile(c, id, name) : null;
  } catch {
    return null;
  }
}

// earlier versions, newest first: [{ name, date }]
export async function listServerHistory(id) {
  const c = await ctx();
  const snap = await c.fs.getDocs(c.fs.query(c.versions(id), c.fs.orderBy('savedAt', 'desc'), c.fs.limit(50)));
  return snap.docs.map(d => ({ name: d.id, date: new Date(d.data().savedAt) }));
}

// the project, its versions and every picture — for good
export async function deleteFromServer(id) {
  const c = await ctx();
  const have = await knownFiles(c, id);
  const versions = await c.fs.getDocs(c.versions(id));
  const w = batcher(c);
  for (const [name, parts] of have) {
    for (let i = 0; i < parts; i++) await w.delete(c.file(id, i ? `${name}~${i}` : name));
  }
  for (const v of versions.docs) await w.delete(v.ref);
  await w.delete(c.manifest(id));
  await w.delete(c.project(id));
  await w.commit();
  known.delete(id);
  thumbs.delete(id);
}
