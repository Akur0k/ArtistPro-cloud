import { muxMp4, StreamingMp4Writer } from './Mp4Muxer.js';
import { readFrameImage, drawFrameImage } from './Frame.js';

const OPFS_TEMP_PREFIX = 'artist-export-tmp-';

// tries to get an OPFS file to stream the export into. Returns null on any
// failure (unsupported browser, quota, etc.) so the caller can fall back to
// the in-memory path — streaming is a pure optimization, never a hard
// requirement, so the export must still work where OPFS isn't available.
async function tryOpenOpfsStream() {
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    // opportunistically clean up a leftover temp file from a previous
    // export (left behind on purpose — see finishStreamingExport below —
    // to avoid deleting a file that might still be mid-share/download).
    for await (const name of root.keys()) {
      if (name.startsWith(OPFS_TEMP_PREFIX)) {
        await root.removeEntry(name).catch(() => {});
      }
    }
    const filename = `${OPFS_TEMP_PREFIX}${Date.now()}.mp4`;
    const fileHandle = await root.getFileHandle(filename, { create: true });
    if (!fileHandle.createWritable) return null;
    const writable = await fileHandle.createWritable();
    return { fileHandle, writable };
  } catch {
    return null;
  }
}

const FPS = 12; // matches the app's playback tick rate (setInterval(...,1000/12))
const FRAME_DURATION_US = 1_000_000 / FPS;
const KEYFRAME_INTERVAL = FPS * 2;

// H.264 level determines the max frame size (in 16x16 macroblocks) a decoder
// is required to handle — level 3.1 (the common "safe default" people copy)
// only covers up to ~1280x720 (3600 MB). This app's canvases can be much
// bigger (the default new-canvas preset alone is 1080x1920 = 8100 MB), and
// isConfigSupported() doesn't reliably catch that mismatch — the hardware
// encoder just fails the actual encode task with a generic error instead.
// Level 5.1 (0x33) covers up to 36864 MB, well past MAX_BACKING_DIMENSION's
// 2048x2048 (16384 MB) cap, so every canvas this app can produce fits.
// Profile still varies for hardware-support breadth (Baseline first).
const CODEC_CANDIDATES = ['avc1.420033', 'avc1.4d0033', 'avc1.640033'];

export function isMp4ExportSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

// many mobile hardware H.264 encoders require macroblock-aligned (multiple
// of 16) frame dimensions and fail encode tasks silently/generically
// otherwise — round up (never down, so nothing gets cropped) rather than
// just to an even number.
function alignTo16(n) {
  return Math.max(16, Math.ceil(n / 16) * 16);
}

// draws the background (color or image), then every visible layer on top of
// it (bottom to top, respecting opacity). tick === null means "whatever each
// layer currently has on screen" (used for the PNG export); a number picks
// each layer's own frame at that global time, same mapping playback/onion-skin
// already use. The background isn't a real layer, so it has to be painted
// explicitly here — H.264 has no alpha channel anyway, so leaving it
// transparent would just turn black.
//
// Frames are read without making them resident (most of a long animation
// is only encoded); `sources` keeps each layer's last decoded frame so a
// frame held for several ticks is decoded once, not once per tick.
// transparent: no background — only what's drawn (a PNG keeps the alpha)
async function compositeAt(layerManager, tick, ctx, width, height, sources = new Map(), { transparent = false } = {}) {
  ctx.clearRect(0, 0, width, height);
  if (!transparent) layerManager.drawBackgroundOnto(ctx, width, height);
  for (const layer of layerManager.layers) {
    if (!layer.visible) continue;
    // an object layer: its picture where it is at that tick
    if (layer.kind === 'object') {
      const t = tick === null ? layer.time : tick;
      if (!layer.inSpan(t)) continue;
      await layer.ready();
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.scale(width / layer.docWidth, height / layer.docHeight);
      layer.drawAt(ctx, t);
      ctx.restore();
      continue;
    }
    // past its last frame a layer shows nothing
    const idx = tick === null ? (layer.ended ? -1 : layer.currentFrameIndex) : layer.frameIndexAtTime(tick);
    const frame = layer.frames[idx];
    if (!frame) continue;
    let entry = sources.get(layer);
    if (!entry || entry.frame !== frame) {
      entry?.src?.release();
      entry = { frame, src: await readFrameImage(frame) };
      sources.set(layer, entry);
    }
    if (!entry.src) continue;
    ctx.globalAlpha = layer.opacity;
    // only the camera area: whatever is drawn outside it falls off the edges
    drawFrameImage(ctx, entry.src, width, height);
  }
  ctx.globalAlpha = 1;
}

function releaseSources(sources) {
  for (const entry of sources.values()) entry.src?.release();
  sources.clear();
}

export async function exportCurrentFramePNG(layerManager, { transparent = false } = {}) {
  const width = layerManager.activeLayer.pixelWidth;
  const height = layerManager.activeLayer.pixelHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const sources = new Map();
  try {
    await compositeAt(layerManager, null, canvas.getContext('2d'), width, height, sources, { transparent });
  } finally {
    releaseSources(sources);
  }
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function pickCodecConfig(width, height) {
  for (const codec of CODEC_CANDIDATES) {
    const config = { codec, width, height, bitrate: 4_000_000, framerate: FPS, avc: { format: 'avc' } };
    try {
      const result = await VideoEncoder.isConfigSupported(config);
      if (result.supported) return config;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// encodes the whole animation (all layers, respecting each layer's own
// frame durations, looping shorter layers — same model as playback) into an
// H.264 stream via WebCodecs, then muxes it into a .mp4 with Mp4Muxer.
// Never touches layerManager's live playhead/DOM display.
export async function exportAnimationMp4(layerManager, { onProgress } = {}) {
  if (!isMp4ExportSupported()) {
    throw new Error('Кодирование видео (WebCodecs) не поддерживается в этом браузере');
  }

  const width = alignTo16(layerManager.activeLayer.pixelWidth);
  const height = alignTo16(layerManager.activeLayer.pixelHeight);
  const totalTicks = layerManager.totalDuration;

  const config = await pickCodecConfig(width, height);
  if (!config) {
    throw new Error('Аппаратное кодирование H.264 недоступно на этом устройстве');
  }

  // stream straight to disk (OPFS) when available so long exports (thousands
  // of frames) never hold every encoded sample's bytes in memory at once —
  // only their sizes do. Falls back to the old in-memory muxing otherwise.
  const opfsStream = await tryOpenOpfsStream();
  const streamWriter = opfsStream ? new StreamingMp4Writer(opfsStream.writable, { width, height, timescale: FPS }) : null;
  const samples = streamWriter ? null : [];
  if (streamWriter) await streamWriter.start();

  let description = null;
  let encodeError = null;
  const pendingChunks = [];

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      pendingChunks.push({ data, key: chunk.type === 'key' });
      const desc = metadata?.decoderConfig?.description;
      if (desc && !description) {
        description = desc instanceof Uint8Array ? desc : new Uint8Array(desc);
      }
    },
    // WebCodecs errors (e.g. "Encoding task failed.") carry no context by
    // themselves — attach what we were attempting so it's actually diagnosable.
    error: e => { encodeError = new Error(`${e.message} [codec=${config.codec}, ${width}x${height}, кадров=${totalTicks}]`); },
  });
  try {
    encoder.configure(config);
  } catch (e) {
    if (streamWriter) await streamWriter.abort();
    throw new Error(`${e.message} [codec=${config.codec}, ${width}x${height}]`);
  }

  // chunks arrive from the encoder in order but asynchronously relative to
  // this loop — draining a FIFO queue here (rather than writing inside the
  // synchronous output callback) is what lets us await each disk write.
  async function drainPendingChunks() {
    while (pendingChunks.length) {
      const sample = pendingChunks.shift();
      if (streamWriter) await streamWriter.addSample(sample.data, sample.key);
      else samples.push(sample);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const sources = new Map();

  try {
    for (let t = 0; t < totalTicks; t++) {
      if (encodeError) throw encodeError;

      await compositeAt(layerManager, t, ctx, width, height, sources);

      if (encoder.encodeQueueSize > 4) {
        await new Promise(resolve => encoder.addEventListener('dequeue', resolve, { once: true }));
      }

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(t * FRAME_DURATION_US),
        duration: Math.round(FRAME_DURATION_US),
      });
      encoder.encode(frame, { keyFrame: t % KEYFRAME_INTERVAL === 0 });
      frame.close();

      await drainPendingChunks();

      onProgress?.(t + 1, totalTicks);
      // yield periodically so the progress UI can repaint and the page stays responsive
      if (t % 4 === 3) await new Promise(r => setTimeout(r, 0));
    }

    await encoder.flush();
    encoder.close();
    await drainPendingChunks();
    if (encodeError) throw encodeError;

    if (!description) {
      throw new Error('Кодировщик не вернул конфигурацию декодера (avcC)');
    }

    if (streamWriter) {
      await streamWriter.finish(description, totalTicks);
      // left in OPFS deliberately (not deleted here) — the file handed back
      // may still be mid-share/download; the NEXT export's tryOpenOpfsStream()
      // cleans up this leftover before starting.
      const opfsFile = await opfsStream.fileHandle.getFile();
      // getFile() on a plain createWritable() output has an empty .type —
      // re-wrap (cheap: Blob-from-Blob doesn't force a full copy) so
      // shareOrDownload/navigator.share actually see it as a video.
      return new Blob([opfsFile], { type: 'video/mp4' });
    }

    const mp4Bytes = muxMp4({
      width, height,
      timescale: FPS,
      durationTicks: totalTicks,
      samples,
      description,
    });
    return new Blob([mp4Bytes], { type: 'video/mp4' });
  } catch (e) {
    if (streamWriter) await streamWriter.abort();
    throw e;
  } finally {
    releaseSources(sources);
  }
}

export async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      // fall through to a plain download if sharing itself failed
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
