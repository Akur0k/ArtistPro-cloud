// Turns a video file into a sequence of encoded frames by seeking a hidden
// <video> element and copying each moment onto a canvas — no demuxer or
// codec library needed, and it decodes whatever the browser itself can play
// (incl. HEVC .mov straight from an iPhone camera in Safari).
//
// Frames are JPEG-encoded one at a time on a single canvas, so the import
// never holds more than one decoded frame in memory.

import { encodeCanvas } from './Frame.js';
import { drawPlaced } from './VideoPlacement.js';

const LOAD_TIMEOUT_MS = 20000;
const SEEK_TIMEOUT_MS = 10000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// resolves on the first of `events`; rejects on a media error, or with
// `stage` in the message if nothing happens within timeoutMs
function waitFor(video, events, stage, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Видео не отвечает (${stage})`));
    }, timeoutMs);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => {
      cleanup();
      reject(new Error(`Не удалось прочитать видео — формат не поддерживается? (${stage}, код ${video.error?.code ?? '?'})`));
    };
    function cleanup() {
      clearTimeout(timer);
      for (const ev of events) video.removeEventListener(ev, onOk);
      video.removeEventListener('error', onErr);
    }
    for (const ev of events) video.addEventListener(ev, onOk);
    video.addEventListener('error', onErr);
  });
}

// opens the file and reads its metadata; call close() when done
export async function openVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  // iOS Safari only decodes frames for an element that's in the document
  // and not fully transparent
  video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;';
  document.body.appendChild(video);
  const close = () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  };
  try {
    const meta = waitFor(video, ['loadedmetadata'], 'загрузка', LOAD_TIMEOUT_MS);
    video.src = url;
    video.load();
    await meta;
    // iOS Safari ignores preload and fetches no picture data until playback
    // starts — kick it with a muted inline play (allowed without a gesture),
    // then pause; seeks after that get real frames
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      const data = waitFor(video, ['loadeddata', 'canplay'], 'первый кадр', LOAD_TIMEOUT_MS);
      try {
        await Promise.race([video.play(), sleep(3000)]);
      } catch {
        // autoplay refused — some browsers load data without it anyway
      }
      await data;
    }
    video.pause();
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('Не удалось определить длину видео');
    }
    return { video, duration: video.duration, width: video.videoWidth, height: video.videoHeight, close };
  } catch (e) {
    close();
    throw e;
  }
}

export async function seekTo(video, t) {
  if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const presented = 'requestVideoFrameCallback' in video
    ? new Promise(resolve => video.requestVideoFrameCallback(() => resolve()))
    : null;
  const seeked = waitFor(video, ['seeked'], `перемотка на ${t.toFixed(2)} с`, SEEK_TIMEOUT_MS);
  video.currentTime = t;
  try {
    await seeked;
  } catch (e) {
    // a missed 'seeked' isn't fatal if the element did land there
    if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) throw e;
  }
  // 'seeked' can fire before the new frame is actually presented — wait for
  // it when the browser can tell us (bounded: an identical frame never fires)
  if (presented) await Promise.race([presented, sleep(120)]);
}

// returns [{ blob, duration }] with duration in animation ticks.
// placement: from placeVideo(), in document units (docWidth wide);
// encoding: 'jpeg' when the placed video covers the whole canvas, 'png'
// (keeps the uncovered rest transparent) otherwise
export async function extractFrames(opened, { width, height, docWidth, placement, encoding, start, end, step, ticksPerFrame, onProgress, isCancelled }) {
  const { video } = opened;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const times = [];
  for (let t = start; t < end - 1e-6; t += step) times.push(t);

  const frames = [];
  for (let i = 0; i < times.length; i++) {
    if (isCancelled?.()) return null;
    await seekTo(video, Math.min(times[i], video.duration - 0.001));
    ctx.clearRect(0, 0, width, height);
    drawPlaced(ctx, video, placement, width / docWidth);
    frames.push({ blob: await encodeCanvas(canvas, encoding), duration: ticksPerFrame });
    onProgress?.(i + 1, times.length);
  }
  return frames;
}
