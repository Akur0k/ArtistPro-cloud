import { Frame, readFrameImage, drawFrameImage, extentFromRect, rectFromExtent, encodeCanvas, TILE } from './Frame.js';

const DB_NAME = 'artist-db';
const DB_VERSION = 2;
const STORE = 'projects';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listProjects() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.updatedAt - a.updatedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function getProject(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putProject(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(record);
    req.onsuccess = () => resolve(req.result); // the id (new or existing)
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProject(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// only frames whose pixels changed since the last save get re-encoded
// (Frame.encode() returns the existing blob otherwise); blank frames are
// stored without pixels. A frame is either tiles ({ x, y, blob }: tile
// coordinates, TILE layer pixels each, relative to the camera) or — an
// untouched imported video frame / older project — one image: blob + rect,
// the area it covers as fractions of the camera.
export function serializeLayers(layerManager) {
  return Promise.all(layerManager.layers.map(async layer => {
    // an object layer: its picture and key poses (see ObjectLayer)
    if (layer.kind === 'object') {
      // drawn on since it was last encoded
      if (layer.piece.dirty) {
        layer.piece.blob = await encodeCanvas(layer.piece.canvas, 'png');
        layer.piece.dirty = false;
      }
      const { blob, w, h } = layer.piece;
      return {
        kind: 'object', name: layer.name, opacity: layer.opacity, visible: layer.visible, tint: layer.tint ?? null,
        encoding: 'png', frames: [], object: { piece: { blob, w, h }, keys: layer.keys.map(k => ({ ...k })) },
      };
    }
    // movements (frame.motion, see main.js) whose first frame is still there
    const motions = [];
    const motionIndex = new Map();
    for (const f of layer.frames) {
      const m = f.motion;
      if (!m || motionIndex.has(m) || (!m.withStart && !layer.frames.includes(m.base))) continue;
      motionIndex.set(m, motions.length);
      motions.push(serializeMotion(layer, m));
    }
    const frames = await Promise.all(layer.frames.map(async frame => {
      const s = await frame.serialize();
      // guide: the frame's fill borders (tiles), if it has any
      const guide = s.guide?.length ? s.guide : undefined;
      // motion: which of the layer's movements made it; motionEdited: drawn on since
      const motion = motionIndex.has(frame.motion)
        ? { motion: motionIndex.get(frame.motion), motionEdited: frame.version !== frame.motionVersion }
        : {};
      // gap: an empty stretch between frames (frames keep their place in time)
      if (frame.gap && frame.isBlank) return { duration: frame.duration, tiles: [], tileSize: TILE, gap: true };
      if (s.tiles) return { duration: frame.duration, tiles: s.tiles, tileSize: TILE, guide, ...motion };
      return { duration: frame.duration, blob: s.blob, rect: rectFromExtent(layer, s.extent), guide, ...motion };
    }));
    // pixels: the scale the tiles are drawn at — so a later version that
    // draws at another one can convert them (ProjectFormat.fitLayerPixels)
    return {
      name: layer.name, opacity: layer.opacity, visible: layer.visible, tint: layer.tint ?? null, encoding: layer.encoding,
      pixels: { dpr: layer.dpr, tileSize: TILE }, frames, motions: motions.length ? motions : undefined, start: layer.start || undefined,
    };
  }));
}

// a movement as stored: base — the index of the frame it starts on
function serializeMotion(layer, m) {
  const { blob, x, y, w, h } = m.piece;
  return {
    base: m.base ? layer.frames.indexOf(m.base) : -1,
    withStart: Boolean(m.withStart),
    piece: { blob, x, y, w, h },
    template: [...m.template.values()].map(t => ({ x: t.tx, y: t.ty, blob: t.blob })),
    end: m.end,
    easing: m.easing,
    count: m.count,
    bend: m.bend,
    waypoints: m.waypoints,
    path: m.path,
  };
}

function restoreMotion(frames, saved) {
  return {
    base: saved.base >= 0 ? frames[saved.base] : null,
    withStart: Boolean(saved.withStart),
    piece: { ...saved.piece, canvas: null },
    template: new Map(saved.template.map(t => [`${t.x},${t.y}`, { tx: t.x, ty: t.y, blob: t.blob }])),
    end: saved.end,
    easing: saved.easing,
    count: saved.count,
    bend: saved.bend ?? null,
    waypoints: saved.waypoints ?? null,
    path: saved.path ?? null,
  };
}

// frames stay encoded — only the ones on screen get decoded (on demand, by
// Layer), so opening a long animation costs neither time nor memory
export function restoreLayers(layerManager, savedLayers) {
  for (const saved of savedLayers) {
    if (saved.kind === 'object') {
      const o = saved.object;
      const layer = layerManager.addObjectLayer(saved.name, { piece: { canvas: null, blob: o.piece.blob, w: o.piece.w, h: o.piece.h }, keys: o.keys });
      layer.opacity = saved.opacity;
      layer.visible = saved.visible;
      layer.tint = saved.tint ?? null;
      layer.ready().catch(() => {});
      continue;
    }
    const layer = layerManager.addLayer(saved.name, { encoding: saved.encoding || 'png' });
    layer.opacity = saved.opacity;
    layer.visible = saved.visible;
    layer.tint = saved.tint ?? null;
    layer.start = saved.start ?? 0;
    layer.replaceFrames(saved.frames.map(f => {
      const duration = Math.max(1, Math.round(f.duration ?? 1));
      const frame = f.tiles
        ? Frame.fromTiles(layer, duration, f.tiles)
        : new Frame(layer, duration, f.blob ?? null, extentFromRect(layer, f.rect));
      if (f.guide?.length) {
        frame.guide = Frame.fromTiles(layer, duration, f.guide);
        frame.guide.isGuide = true;
      }
      if (f.gap) frame.gap = true;
      return frame;
    }));
    const motions = (saved.motions ?? []).map(m => restoreMotion(layer.frames, m));
    saved.frames.forEach((f, i) => {
      const m = motions[f.motion];
      if (!m || (!m.withStart && !m.base)) return;
      layer.frames[i].motion = m;
      // drawn on after it was made: never equal to its version
      layer.frames[i].motionVersion = f.motionEdited ? -1 : layer.frames[i].version;
    });
    layer.applyVisualState();
  }
}

export async function makeThumbnail(layerManager, docWidth, docHeight, maxSize = 300) {
  const scale = Math.min(maxSize / docWidth, maxSize / docHeight, 1);
  const w = Math.max(1, Math.round(docWidth * scale));
  const h = Math.max(1, Math.round(docHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  layerManager.drawBackgroundOnto(ctx, w, h);
  for (const layer of layerManager.layers) {
    if (!layer.visible) continue;
    if (layer.ended) continue; // past its last frame: nothing there
    if (layer.kind === 'object') {
      await layer.ready().catch(() => {});
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.scale(w / docWidth, h / docHeight);
      layer.drawAt(ctx, layer.time);
      ctx.restore();
      continue;
    }
    const src = await readFrameImage(layer.currentFrame, { width: w, height: h }).catch(() => null);
    if (!src) continue;
    ctx.globalAlpha = layer.opacity;
    drawFrameImage(ctx, src, w, h);
    src.release();
  }
  ctx.globalAlpha = 1;
  return new Promise(resolve => c.toBlob(blob => resolve(blob), 'image/png'));
}

// Safari keeps a Blob read out of IndexedDB as a reference to the stored
// file — and deletes that file when the record is written again (every
// autosave). The opened project's pictures would then be unreadable ("The
// object can not be found here"): saves and backups fail. So right after a
// project is read, every picture is copied into memory. Returns how many
// couldn't be read (already lost before this point).
export async function detachBlobs(record) {
  let failed = 0;
  const copy = async b => {
    if (!(b instanceof Blob)) return b;
    try {
      return new Blob([await b.arrayBuffer()], { type: b.type });
    } catch {
      failed++;
      return b;
    }
  };
  const tiles = list => Promise.all((list ?? []).map(async t => ({ ...t, blob: await copy(t.blob) })));
  for (const layer of record.layers ?? []) {
    for (const f of layer.frames) {
      if (f.tiles) f.tiles = await tiles(f.tiles);
      if (f.blob) f.blob = await copy(f.blob);
      if (f.guide) f.guide = await tiles(f.guide);
    }
    if (layer.object) layer.object.piece = { ...layer.object.piece, blob: await copy(layer.object.piece.blob) };
    for (const m of layer.motions ?? []) {
      m.piece = { ...m.piece, blob: await copy(m.piece.blob) };
      m.template = await tiles(m.template);
    }
  }
  if (record.backgroundImageBlob) record.backgroundImageBlob = await copy(record.backgroundImageBlob);
  if (record.thumbnail) record.thumbnail = await copy(record.thumbnail);
  return failed;
}
