// How a project is kept on the computer (nocache_server.py, projects/<id>/):
// project.json plus its pictures as separate PNG / JPEG files.
//
// The format says everything needed to put the pictures back where they
// were, without relying on how the app happens to work today:
//   camera          the camera size, in document units
//   end             where the animation ends, in ticks (null: where the
//                   longest visible layer ends)
//   layer.pixels    the scale the layer's pictures were drawn at (pixels per
//                   document unit) and the tile size — a later version that
//                   draws at another scale converts them (fitLayerPixels)
//   frame.tiles     [{ x, y, file }]: square pictures of tileSize pixels,
//                   x/y counted in tiles from the camera's top left corner
//   frame.picture   { file, rect }: one picture over rect (fractions of the
//                   camera) — imported video frames, older projects
//   layer.kind      'object': a moving picture, not frames — layer.object:
//                   { piece: { file, w, h } (its size, document units),
//                   keys: [{ t, x, y, scale, rotation, ease }] } (see
//                   ObjectLayer); frames is empty
//   frame.gap       an empty stretch between frames (no tiles): frames keep
//                   their place in time when one is deleted or moved
//   frame.guide     the frame's fill borders, as tiles
//   frame.motion    which of layer.motions made the frame (motionEdited:
//                   drawn on since); layer.motions: movements that can be
//                   changed again — { base (frame index; -1 with
//                   withStart: its own frames start at the piece's start,
//                   on a layer of their own), piece: { file,
//                   x, y, w, h } (layer pixels), template (the base frame
//                   without the piece, tiles), end, easing, count, bend,
//                   waypoints, path }
//   (neither tiles nor picture: an empty frame)
//
// A file is named after a hash of its content, so a file is never
// rewritten: saving only sends pictures that changed, and every kept
// earlier version of project.json still has all of its pictures.
//
// Never change what a field of version 2 means — add fields, or make a
// version 3 and keep reading version 2.

import { TILE, newTileCanvas, releaseCanvas, encodeCanvas, isTransparent } from './Frame.js';
import { backingFor } from './Layer.js';
import { blobKey } from './BlobKey.js';

export const FORMAT = 'artist-project';
export const VERSION = 2;

// ---- file names: a hash of the content ----

const names = new WeakMap(); // Blob -> file name (blobs never change)

export async function fileNameFor(blob) {
  let name = names.get(blob);
  if (!name) {
    const ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
    name = `${await blobKey(blob)}.${ext}`;
    names.set(blob, name);
  }
  return name;
}

// ---- a saved project (the app's record) -> project.json + files ----

// record: what doSave() in main.js builds (layers from serializeLayers).
// Returns { json, files: Map(name -> Blob) }
export async function recordToDisk(record) {
  const files = new Map();
  const add = async blob => {
    if (!blob) return null;
    const name = await fileNameFor(blob);
    files.set(name, blob);
    return name;
  };
  const tiles = list => Promise.all(list.map(async t => ({ x: t.x, y: t.y, file: await add(t.blob) })));
  const fallback = backingFor(record.docWidth, record.docHeight).dpr;

  const layers = [];
  for (const layer of record.layers) {
    // an object layer: one picture and its key poses
    if (layer.kind === 'object') {
      const { piece, keys } = layer.object;
      layers.push({
        kind: 'object', name: layer.name, opacity: layer.opacity, visible: layer.visible, tint: layer.tint ?? null,
        object: { piece: { file: await add(piece.blob), w: piece.w, h: piece.h }, keys },
        frames: [],
      });
      continue;
    }
    const frames = [];
    for (const f of layer.frames) {
      const out = { duration: f.duration };
      if (f.tiles) {
        if (f.tiles.length) out.tiles = await tiles(f.tiles);
      } else if (f.blob) {
        out.picture = { file: await add(f.blob), rect: f.rect ?? { x: 0, y: 0, w: 1, h: 1 } };
      }
      if (f.guide?.length) out.guide = await tiles(f.guide);
      if (f.gap) out.gap = true;
      if (f.motion != null) {
        out.motion = f.motion;
        out.motionEdited = Boolean(f.motionEdited);
      }
      frames.push(out);
    }
    layers.push({
      name: layer.name,
      opacity: layer.opacity,
      visible: layer.visible,
      // shown in this one color on screen (null: its own colors)
      tint: layer.tint ?? null,
      encoding: layer.encoding || 'png',
      // saved before layers recorded it: drawn at what backingFor gives
      pixels: layer.pixels ?? { dpr: fallback, tileSize: TILE },
      // the tick its first frame starts at (empty before)
      start: layer.start || 0,
      frames,
      motions: layer.motions?.length ? await Promise.all(layer.motions.map(async m => ({
        ...m,
        piece: { file: await add(m.piece.blob), x: m.piece.x, y: m.piece.y, w: m.piece.w, h: m.piece.h },
        template: await tiles(m.template),
      }))) : undefined,
    });
  }

  let thumbnail = null;
  if (record.thumbnail) {
    thumbnail = 'thumb.png';
    files.set(thumbnail, record.thumbnail);
  }
  const json = {
    format: FORMAT,
    version: VERSION,
    name: record.name,
    updatedAt: record.updatedAt,
    camera: { width: record.docWidth, height: record.docHeight },
    playhead: record.playhead ?? 0,
    // where the animation ends, in ticks (null: where the longest visible
    // layer ends)
    end: record.endTime ?? null,
    activeLayerIndex: record.activeLayerIndex ?? 0,
    background: {
      mode: record.backgroundMode || 'color',
      color: record.backgroundColor || '#ffffff',
      image: record.backgroundMode === 'image' ? await add(record.backgroundImageBlob) : null,
    },
    thumbnail,
    layers,
  };
  return { json, files };
}

// ---- project.json + files -> the app's record ----

// getFile(name) -> Promise<Blob>
export async function diskToRecord(json, getFile) {
  if (json?.format !== FORMAT) throw new Error('Это не проект Artist');
  if (json.version !== VERSION) throw new Error(`Проект сохранён более новой версией приложения (формат ${json.version})`);
  const get = name => (name ? getFile(name) : Promise.resolve(null));
  const tiles = list => Promise.all(list.map(async t => ({ x: t.x, y: t.y, blob: await get(t.file) })));

  const layers = await Promise.all(json.layers.map(async layer => (layer.kind === 'object' ? {
    kind: 'object',
    name: layer.name,
    opacity: layer.opacity ?? 1,
    visible: layer.visible !== false,
    tint: layer.tint ?? null,
    frames: [],
    object: { piece: { blob: await get(layer.object.piece.file), w: layer.object.piece.w, h: layer.object.piece.h }, keys: layer.object.keys },
  } : {
    name: layer.name,
    opacity: layer.opacity ?? 1,
    visible: layer.visible !== false,
    tint: layer.tint ?? null,
    encoding: layer.encoding || 'png',
    pixels: layer.pixels,
    start: layer.start ?? 0,
    frames: await Promise.all(layer.frames.map(async f => {
      const guide = f.guide ? await tiles(f.guide) : undefined;
      const motion = {
        ...(f.motion != null ? { motion: f.motion, motionEdited: Boolean(f.motionEdited) } : {}),
        ...(f.gap ? { gap: true } : {}),
      };
      if (f.picture) return { duration: f.duration, blob: await get(f.picture.file), rect: f.picture.rect, guide, ...motion };
      return { duration: f.duration, tiles: f.tiles ? await tiles(f.tiles) : [], tileSize: layer.pixels?.tileSize ?? TILE, guide, ...motion };
    })),
    motions: layer.motions ? await Promise.all(layer.motions.map(async m => ({
      ...m,
      piece: { blob: await get(m.piece.file), x: m.piece.x, y: m.piece.y, w: m.piece.w, h: m.piece.h },
      template: await tiles(m.template),
    }))) : undefined,
  })));

  return {
    docWidth: json.camera.width,
    docHeight: json.camera.height,
    activeLayerIndex: json.activeLayerIndex ?? 0,
    layers,
    thumbnail: json.thumbnail ? await get(json.thumbnail).catch(() => null) : null,
    playhead: json.playhead ?? 0,
    endTime: json.end ?? null,
    backgroundMode: json.background?.mode || 'color',
    backgroundColor: json.background?.color || '#ffffff',
    backgroundImageBlob: json.background?.image ? await get(json.background.image) : null,
    name: json.name,
    updatedAt: json.updatedAt,
  };
}

// ---- a layer drawn at another scale (or tile size) than the app uses now ----

// Redraws its tiles at dpr / TILE, in place (the layer record's frames).
// Pictures (frame.picture) are placed by fractions of the camera and need
// nothing.
export async function fitLayerPixels(layer, docWidth, docHeight) {
  if (layer.kind === 'object') return false; // sized in document units
  const dpr = backingFor(docWidth, docHeight).dpr;
  const from = layer.pixels;
  if (!from || (Math.abs(from.dpr - dpr) < 1e-6 && (from.tileSize ?? TILE) === TILE)) return false;
  const k = dpr / from.dpr;
  const size = from.tileSize ?? TILE;
  const encoding = layer.encoding === 'jpeg' ? 'jpeg' : 'png';
  const redo = async (list, enc) => {
    if (!list?.length) return list;
    const src = await Promise.all(list.map(async t => ({ x: t.x, y: t.y, bitmap: await createImageBitmap(t.blob) })));
    const keys = new Set();
    for (const t of src) {
      const x0 = Math.floor((t.x * size * k) / TILE);
      const y0 = Math.floor((t.y * size * k) / TILE);
      const x1 = Math.floor((((t.x + 1) * size * k) - 1e-6) / TILE);
      const y1 = Math.floor((((t.y + 1) * size * k) - 1e-6) / TILE);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) keys.add(`${x},${y}`);
    }
    const out = [];
    for (const key of keys) {
      const [x, y] = key.split(',').map(Number);
      const c = newTileCanvas();
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      for (const t of src) ctx.drawImage(t.bitmap, t.x * size * k - x * TILE, t.y * size * k - y * TILE, size * k, size * k);
      if (!isTransparent(c)) out.push({ x, y, blob: await encodeCanvas(c, enc) });
      releaseCanvas(c);
    }
    for (const t of src) t.bitmap.close?.();
    return out;
  };
  for (const f of layer.frames) {
    if (f.tiles) {
      f.tiles = await redo(f.tiles, encoding);
      f.tileSize = TILE;
    }
    if (f.guide) f.guide = await redo(f.guide, 'png');
  }
  layer.pixels = { dpr, tileSize: TILE };
  // a movement's piece and template are at the old scale — its frames stay,
  // it just can't be changed any more
  delete layer.motions;
  for (const f of layer.frames) delete f.motion;
  return true;
}
