// Whole-project backup: bundles every layer/frame + background into one
// self-contained JSON file (frames as data: URLs) that can be saved outside
// the browser (Files app, cloud drive) and re-imported later as a new
// project — so work doesn't depend solely on this origin's IndexedDB
// surviving. Deliberately plain JSON, not a zip: no external library, and
// this is a rarely-used, user-initiated action, so the base64 size overhead
// doesn't matter the way it would on a hot path.

import { serializeLayers } from './Storage.js';

const FORMAT_VERSION = 1;

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataURL) {
  const res = await fetch(dataURL);
  return res.blob();
}

const tilesToData = tiles => Promise.all(tiles.map(async t => ({ x: t.x, y: t.y, image: await blobToDataURL(t.blob) })));
const tilesFromData = tiles => Promise.all(tiles.map(async t => ({ x: t.x, y: t.y, blob: await dataURLToBlob(t.image) })));

export async function exportProjectBackup(layerManager, meta) {
  // same encoded frames autosave uses (only changed ones get re-encoded);
  // a blank frame is image: null
  const serialized = await serializeLayers(layerManager);
  const layers = await Promise.all(serialized.map(async layer => ({
    name: layer.name,
    opacity: layer.opacity,
    visible: layer.visible,
    tint: layer.tint ?? null,
    encoding: layer.encoding,
    // an object layer: its picture and key poses
    kind: layer.kind,
    start: layer.start,
    object: layer.object
      ? { piece: { image: await blobToDataURL(layer.object.piece.blob), w: layer.object.piece.w, h: layer.object.piece.h }, keys: layer.object.keys }
      : undefined,
    frames: await Promise.all(layer.frames.map(async f => ({
      ...(f.tiles
        ? {
          duration: f.duration,
          tileSize: f.tileSize,
          tiles: await tilesToData(f.tiles),
        }
        : {
          duration: f.duration,
          image: f.blob ? await blobToDataURL(f.blob) : null,
          rect: f.rect,
        }),
      // fill borders
      guide: f.guide ? await tilesToData(f.guide) : undefined,
    }))),
  })));

  const backgroundImage = layerManager.backgroundMode === 'image' && layerManager.backgroundImageBlob
    ? await blobToDataURL(layerManager.backgroundImageBlob)
    : null;

  const data = {
    formatVersion: FORMAT_VERSION,
    docWidth: meta.docWidth,
    docHeight: meta.docHeight,
    // the camera in layer pixels — where tiles sit relative to it
    cameraPixels: meta.cameraPixels,
    name: meta.name,
    playhead: layerManager.playhead,
    backgroundMode: layerManager.backgroundMode,
    backgroundColor: layerManager.backgroundColor,
    backgroundImage,
    layers,
  };

  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

async function makeBackupThumbnail(data, maxSize = 300) {
  const scale = Math.min(maxSize / data.docWidth, maxSize / data.docHeight, 1);
  const w = Math.max(1, Math.round(data.docWidth * scale));
  const h = Math.max(1, Math.round(data.docHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  if (data.backgroundMode === 'image' && data.backgroundImage) {
    const bitmap = await createImageBitmap(await dataURLToBlob(data.backgroundImage));
    ctx.drawImage(bitmap, 0, 0, w, h);
  } else {
    ctx.fillStyle = data.backgroundColor || '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }

  for (const layer of data.layers) {
    const f = layer.frames[0];
    if (!layer.visible || !f) continue;
    ctx.globalAlpha = layer.opacity;
    if (f.tiles && data.cameraPixels) {
      const [pw, ph] = data.cameraPixels;
      const size = f.tileSize || 512;
      for (const t of f.tiles) {
        const x = t.x * size;
        const y = t.y * size;
        if (x >= pw || y >= ph || x + size <= 0 || y + size <= 0) continue;
        const bitmap = await createImageBitmap(await dataURLToBlob(t.image));
        ctx.drawImage(bitmap, (x / pw) * w, (y / ph) * h, (size / pw) * w, (size / ph) * h);
      }
    } else if (f.image) {
      const bitmap = await createImageBitmap(await dataURLToBlob(f.image));
      const r = f.rect ?? { x: 0, y: 0, w: 1, h: 1 };
      ctx.drawImage(bitmap, r.x * w, r.y * h, r.w * w, r.h * h);
    }
  }
  ctx.globalAlpha = 1;

  return new Promise(resolve => c.toBlob(resolve, 'image/png'));
}

// parses a backup file and returns a project record ready for putProject()
// — i.e. the same shape doSave() in main.js builds, so it opens exactly like
// any other saved project.
export async function importProjectBackup(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл повреждён или это не бэкап Artist');
  }
  if (!data || data.formatVersion !== FORMAT_VERSION) {
    throw new Error('Не похоже на файл бэкапа Artist (неизвестная версия)');
  }

  const layers = await Promise.all(data.layers.map(async layer => ({
    name: layer.name,
    opacity: layer.opacity,
    visible: layer.visible,
    tint: layer.tint ?? null,
    encoding: layer.encoding || 'png',
    kind: layer.kind,
    start: layer.start ?? 0,
    object: layer.object
      ? { piece: { blob: await dataURLToBlob(layer.object.piece.image), w: layer.object.piece.w, h: layer.object.piece.h }, keys: layer.object.keys }
      : undefined,
    frames: await Promise.all(layer.frames.map(async f => ({
      ...(f.tiles
        ? {
          duration: f.duration,
          tileSize: f.tileSize,
          tiles: await tilesFromData(f.tiles),
        }
        : {
          blob: f.image ? await dataURLToBlob(f.image) : null,
          duration: f.duration,
          rect: f.rect ?? null,
        }),
      guide: f.guide ? await tilesFromData(f.guide) : undefined,
    }))),
  })));

  const backgroundImageBlob = data.backgroundMode === 'image' && data.backgroundImage
    ? await dataURLToBlob(data.backgroundImage)
    : null;

  const thumbnail = await makeBackupThumbnail(data);

  return {
    docWidth: data.docWidth,
    docHeight: data.docHeight,
    activeLayerIndex: 0,
    layers,
    thumbnail,
    playhead: data.playhead || 0,
    backgroundMode: data.backgroundMode || 'color',
    backgroundColor: data.backgroundColor || '#ffffff',
    backgroundImageBlob,
    name: `${data.name || 'Без названия'} (импорт)`,
    updatedAt: Date.now(),
  };
}
