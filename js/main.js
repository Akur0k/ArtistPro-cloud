import { dlog, setStateProvider } from './DebugLog.js';
import { squareToQuad, warpCanvas } from './Warp.js';
import { Display } from './Display.js';
import { applyIcons, setIcon } from './Icons.js';
import { mergeDown } from './MergeLayers.js';
import { installTapFix } from './TapFix.js';
import { LayerManager, drawImageCover } from './LayerManager.js';
import { History } from './History.js';
import { StrokeRenderer } from './Stroke.js';
import { LayersPanel } from './LayersPanel.js';
import { ViewTransform } from './ViewTransform.js';
import { centroid, distance, angle } from './GestureMath.js';
import { floodFill } from './floodFill.js';
import { SelectionOverlay } from './SelectionOverlay.js';
import { pathBoundingBox, extractRegions, clearMaskArea, clearMaskOnContext, regionsRectPx, regionsOutline } from './Selection.js';
import { putProject, serializeLayers, restoreLayers, makeThumbnail, detachBlobs } from './Storage.js';
import { saveToServer, serverAvailable, newServerId, cloudUser } from './CloudStore.js';
import { fitLayerPixels } from './ProjectFormat.js';
import { Frame, encodeCanvas, releaseCanvas, residentStats, isTransparent, newTileCanvas, tileRange, intersectRect, TILE } from './Frame.js';
import { showHomeScreen } from './HomeScreen.js';
import { Timeline } from './Timeline.js';
import { openExportDialog, showExportProgress, updateExportProgress, hideExportDialog } from './ExportDialog.js';
import { exportCurrentFramePNG, exportAnimationMp4, shareOrDownload, isMp4ExportSupported } from './VideoExport.js';
import { openBackgroundDialog } from './BackgroundDialog.js';
import { exportProjectBackup } from './ProjectBackup.js';
import { openVideo, extractFrames } from './VideoImport.js';
import { openVideoImportDialog, showVideoImportProgress, hideVideoImportDialog } from './VideoImportDialog.js';
import { placeVideo, coversDocument, drawPlaced, placedBounds } from './VideoPlacement.js';
import { EASINGS, EASING_FNS } from './Easing.js';

// fill borders ("границы"): thin lines the bucket stops at, never exported
const GUIDE_COLOR = '#00b4ff';
const GUIDE_WIDTH = 3; // document units

const canvasWrap = document.getElementById('canvasWrap');
const layerStack = document.getElementById('layerStack');
const layersPanelEl = document.getElementById('layersPanel');
const layersBackdropEl = document.getElementById('layersBackdrop');
const layersListEl = document.getElementById('layersList');
const layersToggleBtn = document.getElementById('layersToggleBtn');
const addLayerBtn = document.getElementById('addLayerBtn');
const bgButton = document.getElementById('bgButton');
const importVideoBtn = document.getElementById('importVideoBtn');
const videoFileInput = document.getElementById('videoFileInput');
const importImageBtn = document.getElementById('importImageBtn');
const imageFileInput = document.getElementById('imageFileInput');
const fitViewBtn = document.getElementById('fitViewBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const brushBtn = document.getElementById('brushBtn');
const fillBtn = document.getElementById('fillBtn');
const lassoBtn = document.getElementById('lassoBtn');
const guideBtn = document.getElementById('guideBtn');
const guidesToggleBtn = document.getElementById('guidesToggleBtn');
const colorPicker = document.getElementById('colorPicker');
const sizeSlider = document.getElementById('sizeSlider');
const sizeLabel = document.getElementById('sizeLabel');
const sizeDownBtn = document.getElementById('sizeDownBtn');
const sizeUpBtn = document.getElementById('sizeUpBtn');
const clearBtn = document.getElementById('clearBtn');
const selectionBarEl = document.getElementById('selectionBar');
const copySelBtn = document.getElementById('copySelBtn');
const flipHSelBtn = document.getElementById('flipHSelBtn');
const flipVSelBtn = document.getElementById('flipVSelBtn');
const warpSelBtn = document.getElementById('warpSelBtn');
const cutSelBtn = document.getElementById('cutSelBtn');
const tweenBtn = document.getElementById('tweenBtn');
const makeObjectBtn = document.getElementById('makeObjectBtn');
const objectBarEl = document.getElementById('objectBar');
const objectHintEl = document.getElementById('objectHint');
const objectEaseBtn = document.getElementById('objectEaseBtn');
const objectDelKeyBtn = document.getElementById('objectDelKeyBtn');
const tweenBarEl = document.getElementById('tweenBar');
const tweenFewerBtn = document.getElementById('tweenFewerBtn');
const tweenMoreBtn = document.getElementById('tweenMoreBtn');
const tweenCountEl = document.getElementById('tweenCount');
const tweenEaseBtn = document.getElementById('tweenEaseBtn');
const tweenPlayBtn = document.getElementById('tweenPlayBtn');
const tweenPathBtn = document.getElementById('tweenPathBtn');
const pathBarEl = document.getElementById('pathBar');
const editMotionBtn = document.getElementById('editMotionBtn');
const regenMotionBtn = document.getElementById('regenMotionBtn');
const polyBtn = document.getElementById('polyBtn');
const polyBarEl = document.getElementById('polyBar');
const polyHintEl = document.getElementById('polyHint');
const polyModeBtn = document.getElementById('polyModeBtn');
const polyUndoBtn = document.getElementById('polyUndoBtn');
const polyCancelBtn = document.getElementById('polyCancelBtn');
const polyDoneBtn = document.getElementById('polyDoneBtn');
const pathUndoBtn = document.getElementById('pathUndoBtn');
const pathCancelBtn = document.getElementById('pathCancelBtn');
const pathDoneBtn = document.getElementById('pathDoneBtn');
const tweenBarCancelBtn = document.getElementById('tweenBarCancelBtn');
const tweenBarOkBtn = document.getElementById('tweenBarOkBtn');
const deselectSelBtn = document.getElementById('deselectSelBtn');
const cancelSelBtn = document.getElementById('cancelSelBtn');
const selModeBtn = document.getElementById('selModeBtn');
const pasteBtn = document.getElementById('pasteBtn');
const homeBtn = document.getElementById('homeBtn');
const saveBtn = document.getElementById('saveBtn');
const trackLabelsEl = document.getElementById('trackLabels');
const tracksInnerEl = document.getElementById('tracksInner');
const trackScrollEl = document.getElementById('trackScroll');
const playheadLineEl = document.getElementById('playheadLine');
const timeRulerEl = document.getElementById('timeRuler');
const frameIndicatorEl = document.getElementById('frameIndicator');
const playBtn = document.getElementById('playBtn');
const onionBtn = document.getElementById('onionBtn');
const layerColorsBtn = document.getElementById('layerColorsBtn');
const removeFrameBtn = document.getElementById('removeFrameBtn');
const addFrameBtn = document.getElementById('addFrameBtn');
const shiftLeftBtn = document.getElementById('shiftLeftBtn');
const shiftRightBtn = document.getElementById('shiftRightBtn');
const timelineToggleBtn = document.getElementById('timelineToggleBtn');
const timelineShowBtn = document.getElementById('timelineShowBtn');
const timelineBarEl = document.getElementById('timelineBar');
const exportBtn = document.getElementById('exportBtn');

async function main() {
  // reduce the odds the OS clears IndexedDB storage under disk pressure —
  // best-effort, no UI needed either way (browsers grant/deny silently based
  // on their own heuristics).
  navigator.storage?.persist?.().catch(() => {});
  applyIcons();
  installTapFix();

  const choice = await showHomeScreen();

  const docWidth = choice.mode === 'open' ? choice.project.docWidth : choice.width;
  const docHeight = choice.mode === 'open' ? choice.project.docHeight : choice.height;

  layerStack.style.width = `${docWidth}px`;
  layerStack.style.height = `${docHeight}px`;
  layerStack.style.marginLeft = `${-docWidth / 2}px`;
  layerStack.style.marginTop = `${-docHeight / 2}px`;

  const layerManager = new LayerManager(layerStack);
  const history = new History();
  const view = new ViewTransform(docWidth, docHeight);

  // The layer stack is an empty box the size of the camera (what gets
  // exported) that moves with the view — only the video / picture
  // placement preview sits in it. The drawing itself is painted by Display
  // onto one screen-sized canvas: the drawing area has no edge.
  let onionEnabled = false;
  let playTimer = null;
  let guidesVisible = true;
  const display = new Display({
    wrap: canvasWrap,
    layerManager,
    view,
    docWidth,
    docHeight,
    getOnion: () => onionEnabled && !playTimer,
    getGuides: () => guidesVisible && !playTimer,
  });

  let currentProjectId = choice.mode === 'open' ? choice.project.id : null;
  // the project's backup folder on the computer (projects/<serverId>)
  const currentServerId = (choice.mode === 'open' && choice.project.serverId) || newServerId();
  const projectName = choice.mode === 'open'
    ? (choice.project.name || 'Без названия')
    : `Проект ${new Date().toLocaleDateString('ru-RU')}`;

  // autosave: to the phone only (IndexedDB), as soon as something changed —
  // the computer is never involved (that's the save button's job)
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveBtn.classList.add('unsaved'); // a dot: changes since the last backup
    saveTimer = setTimeout(() => {
      saveTimer = null;
      doSave();
    }, 800);
  }
  // returns the saved record, or null (nothing saved)
  async function doSave() {
    if (floatingFragment) return null; // don't persist a piece mid-air — save again once it's dropped
    const layers = await serializeLayers(layerManager);
    const activeLayerIndex = layerManager.layers.indexOf(layerManager.activeLayer);
    const thumbnail = await makeThumbnail(layerManager, docWidth, docHeight);
    const record = {
      docWidth, docHeight, activeLayerIndex, layers, thumbnail,
      playhead: layerManager.playhead,
      endTime: layerManager.endTime,
      backgroundMode: layerManager.backgroundMode,
      backgroundColor: layerManager.backgroundColor,
      backgroundImageBlob: layerManager.backgroundMode === 'image' ? layerManager.backgroundImageBlob : null,
      name: projectName,
      updatedAt: Date.now(),
      serverId: currentServerId,
    };
    if (currentProjectId != null) record.id = currentProjectId;
    const id = await putProject(record).catch(e => {
      dlog('save-error', { msg: String(e?.message || e) });
      return null;
    });
    if (id == null) return null;
    currentProjectId = id;
    record.id = id;
    return record;
  }

  // the save button: saves on the phone, then sends the project to the
  // cloud (the signed-in account) — the only time anything goes there. Each
  // press is a version that can be opened again later
  let lastBackupError = '';
  async function backupToCloud() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const record = await doSave();
    if (!record) return 'not-saved';
    if (!(await cloudUser())) return 'signed-out';
    if (!(await serverAvailable())) return 'offline';
    try {
      await saveToServer(record, { timeoutMs: 120000 });
      return 'computer';
    } catch (e) {
      lastBackupError = String(e?.message || e);
      dlog('backup-error', { msg: lastBackupError, stack: String(e?.stack || '').slice(0, 500) });
      return 'failed';
    }
  }

  // the save button: saves right now and says where it went
  const saveToast = document.createElement('div');
  saveToast.className = 'save-toast';
  document.getElementById('app').appendChild(saveToast);
  let saveToastTimer = 0;
  function showSaveToast(text, kind) {
    saveToast.textContent = text;
    saveToast.className = `save-toast show ${kind}`;
    clearTimeout(saveToastTimer);
    saveToastTimer = setTimeout(() => { saveToast.className = 'save-toast'; }, kind === 'warn' ? 8000 : 2500);
  }
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.classList.contains('busy')) return;
    if (floatingFragment) {
      showSaveToast('Сначала закончите с выделением (✓)', 'warn');
      return;
    }
    saveBtn.classList.add('busy');
    setIcon(saveBtn, 'loader-circle');
    const result = await backupToCloud();
    saveBtn.classList.remove('busy');
    if (result === 'computer') {
      if (!saveTimer) saveBtn.classList.remove('unsaved');
      setIcon(saveBtn, 'check');
      showSaveToast('Сохранено в облаке', 'ok');
    } else {
      setIcon(saveBtn, 'triangle-alert');
      showSaveToast({
        offline: 'Нет интернета — проект сохранён только в телефоне',
        'signed-out': 'Войдите в аккаунт на экране проектов — пока проект сохранён только в телефоне',
        failed: `Не удалось сохранить в облако (${lastBackupError}) — проект сохранён в телефоне`,
        'not-saved': 'Не удалось сохранить',
      }[result], 'warn');
    }
    setTimeout(() => setIcon(saveBtn, 'save'), 2000);
  });

  if (choice.mode === 'open') {
    // into memory: Safari drops the stored files on the next save
    const unreadable = await detachBlobs(choice.project);
    if (unreadable) dlog('unreadable-pictures', { n: unreadable });
    // pictures drawn at another scale than this version draws at
    for (const layer of choice.project.layers) {
      if (await fitLayerPixels(layer, docWidth, docHeight)) dlog('rescaled-layer', { name: layer.name });
    }
    restoreLayers(layerManager, choice.project.layers);
    layerManager.endTime = choice.project.endTime ?? null;
    layerManager.setPlayhead(choice.project.playhead ?? 0);
    if (choice.project.backgroundMode === 'image' && choice.project.backgroundImageBlob) {
      await layerManager.setBackgroundImage(choice.project.backgroundImageBlob);
    } else {
      layerManager.setBackgroundColor(choice.project.backgroundColor ?? '#ffffff');
    }
    const activeLayer = layerManager.layers[choice.project.activeLayerIndex];
    if (activeLayer) layerManager.setActive(activeLayer.id);
  } else {
    layerManager.setBackgroundColor('#ffffff');
    layerManager.addLayer('Слой 1');
  }

  dlog('open', {
    mode: choice.mode, doc: [docWidth, docHeight],
    layers: layerManager.layers.map(l => ({ frames: l.frameCount, enc: l.encoding, px: [l.pixelWidth, l.pixelHeight], dpr: +l.dpr.toFixed(3) })),
  });
  // how each frame is stored (tiles: their range; one image: where it goes
  // and how big it really is) — for drawings that open in the wrong place
  (async () => {
    for (const [li, l] of layerManager.layers.entries()) {
      const frames = [];
      for (const f of l.frames.slice(0, 6)) {
        if (f.legacy) {
          let size = null;
          try {
            const b = await createImageBitmap(f.legacy.blob);
            size = [b.width, b.height];
            b.close();
          } catch { /* undecodable */ }
          frames.push({ legacy: f.legacy.extent, img: size });
        } else {
          const ks = [...f.tiles.values()];
          frames.push(ks.length
            ? { tiles: ks.length, x: [Math.min(...ks.map(t => t.tx)), Math.max(...ks.map(t => t.tx))], y: [Math.min(...ks.map(t => t.ty)), Math.max(...ks.map(t => t.ty))] }
            : 'blank');
        }
      }
      dlog('open-frames', { layer: li, name: l.name, frames });
    }
  })();
  setStateProvider(() => {
    const r = residentStats();
    const cur = layerManager.activeLayer?.currentFrame;
    return {
      mode, tool, scale: +view.scale.toFixed(3), pan: [Math.round(view.panX), Math.round(view.panY)],
      resident: { n: r.frames, mb: Math.round(r.bytes / 1048576) },
      histMb: Math.round(history.totalBytes() / 1048576), undo: history.undoStack.length,
      curTiles: cur ? cur.tiles.size : null,
      size,
    };
  });

  const layersPanel = new LayersPanel(layerManager, layersListEl, {
    onChange: () => {
      // the active layer may have changed — that moves the selected frame
      timeline.updatePlayhead();
      // a layer hidden / shown: the animation may end elsewhere now
      timeline.renderRuler();
      scheduleSave();
    },
    onStructureChange: () => {
      timeline.render();
      renderOnionSkin();
    },
    onMerge: layer => mergeLayerDown(layer),
    // a layer's color chosen / taken off: its frames' pictures change too;
    // a color chosen shows (the colors mode comes on)
    onTintChange: layer => {
      if (layer.tint && !layerManager.tintsShown) setLayerColors(true);
      else timeline.render();
      scheduleSave();
    },
    onBeforeRemove: layer => {
      stopPlayback();
      // a lifted selection or a stroke in progress belongs to some layer —
      // settle it before anything is deleted
      if (floatingFragment) clearSelection();
      history.forgetLayer(layer.id);
      updateHistoryButtons();
    },
  });
  layersPanel.render();

  const timeline = new Timeline(layerManager, {
    labelsEl: trackLabelsEl,
    innerEl: tracksInnerEl,
    playheadEl: playheadLineEl,
    rulerEl: timeRulerEl,
    indicatorEl: frameIndicatorEl,
    scrollEl: trackScrollEl,
  }, {
    onSelect: (layer, frameIndex) => { stopPlayback(); selectFrame(layer, frameIndex); },
    onDurationChange: () => scheduleSave(),
    // the selected frame pulled longer: copies of it, one per tick — one
    // undo step
    onStretch: (layer, frameIndex, extra) => {
      stopPlayback();
      const source = layer.frames[frameIndex];
      history.beginBatch(layer, frameIndex + 1);
      for (let k = 1; k <= extra; k++) {
        const frame = source.isBlank ? new Frame(layer, 1) : source.copy(1);
        layer.insertFrameObject(frameIndex + k, frame);
        history.recordInsert(frameIndex + k, frame);
      }
      history.commitBatch();
      selectFrame(layer, frameIndex + extra);
      updateHistoryButtons();
    },
    onEndChange: () => scheduleSave(),
    onFrameDrop: (layer, frameIndex, t) => {
      stopPlayback();
      moveFrameTo(layer, frameIndex, t);
    },
    onKeySelect: (layer, t) => {
      stopPlayback();
      layerManager.setActive(layer.id);
      layerManager.setPlayhead(t);
      layersPanel.render();
      timeline.render();
      renderOnionSkin();
    },
    // a key dragged to another tick (not onto another key)
    onKeyMove: (layer, from, to) => {
      stopPlayback();
      if (layer.keyAt(to)) {
        timeline.render();
        return;
      }
      changeKeys(layer, keys => { keys.find(k => k.t === from).t = to; });
      layerManager.setActive(layer.id);
      layerManager.setPlayhead(to);
      layersPanel.render();
      timeline.render();
      renderOnionSkin();
    },
    onActivateLayer: () => layersPanel.render(),
    onReorder: (layer, from, to) => {
      // layer.moveFrame() already ran (Timeline performs the move itself);
      // record it here after the fact since a pure index swap is safe to
      // capture retroactively — replaying it doesn't need before/after snapshots.
      history.beginBatch(layer, to);
      history.recordMove(from, to);
      history.commitBatch();
      updateHistoryButtons();
    },
    onAddFrame: layer => {
      stopPlayback();
      // at the end of the layer
      addFrameAt(layer, layer.frameCount);
      layerManager.setActive(layer.id);
      layersPanel.render();
      timeline.render();
      renderOnionSkin();
      updateHistoryButtons();
    },
    // a track's eye: the layers panel shows the same
    onVisibility: () => {
      layersPanel.render();
      scheduleSave();
    },
    onScrub: t => {
      stopPlayback();
      layerManager.setPlayhead(t);
      timeline.updatePlayhead();
      for (const layer of layerManager.layers) layersPanel.refreshThumbnail(layer);
      renderOnionSkin();
    },
  });

  // onion skin is drawn by Display from the neighbouring frames — make
  // sure they're decoded, then redraw
  // a layer merged into the one under it (not undoable, like deleting a layer)
  async function mergeLayerDown(upper) {
    const i = layerManager.layers.indexOf(upper);
    const lower = layerManager.layers[i - 1];
    if (!lower) return;
    if (!confirm(`Объединить «${upper.name}» со слоем «${lower.name}»? Отменить это нельзя.`)) return;
    stopPlayback();
    if (floatingFragment) clearSelection();
    showExportProgress('Объединение слоёв…');
    let result = null;
    try {
      result = await mergeDown(layerManager, upper, (done, total) => updateExportProgress(done, total, 'Объединение слоёв…'));
    } catch (e) {
      alert('Не удалось объединить слои: ' + e.message);
    } finally {
      hideExportDialog();
    }
    if (!result) return;
    // undo steps of either layer no longer fit their frames
    history.forgetLayer(upper.id);
    history.forgetLayer(lower.id);
    lower.encoding = result.encoding;
    lower.opacity = 1; // baked into the pixels
    lower.start = 0; // the merged frames run from 0
    lower.tint = null; // the merged picture has the layers' own colors
    lower.replaceFrames(result.frames);
    layerManager.removeLayer(upper.id);
    layerManager.setActive(lower.id);
    lower.syncToTime(layerManager.playhead);
    updateHistoryButtons();
    layersPanel.render();
    timeline.render();
    renderOnionSkin();
    scheduleSave();
  }

  function renderOnionSkin() {
    updateMotionBtn();
    updateObjectBar();
    layerManager.onion = onionEnabled;
    if (onionEnabled && !playTimer) for (const layer of layerManager.layers) layer.prefetch(false, true);
    display.invalidate();
  }

  // an encoded frame finished decoding: whatever showed a stale/missing
  // image for it can redraw now (coalesced — playback decodes several at once)
  let frameReadyRaf = 0;
  layerManager.onFrameReady = layer => {
    layersPanel.refreshThumbnail(layer);
    if (frameReadyRaf) return;
    frameReadyRaf = requestAnimationFrame(() => {
      frameReadyRaf = 0;
      display.invalidate();
    });
  };

  function selectFrame(layer, frameIndex) {
    layerManager.setActive(layer.id);
    let t = layer.start;
    for (let i = 0; i < frameIndex; i++) t += layer.frameDurationAt(i);
    layerManager.setPlayhead(t);
    layersPanel.render();
    timeline.render();
    renderOnionSkin();
  }

  const overlay = new SelectionOverlay(display);
  // for tests / debugging from the console
  window.__artist = { layerManager, view, display, history, tween: () => tweenEdit };

  // --- all mutable state declared up front, before anything gets called ---
  let tool = 'brush';
  let drawTool = 'brush'; // which of brush/eraser the combined button is on
  let guideErase = false; // the border tool erases borders instead
  let color = '#111111';
  let size = 8;
  // brush and eraser each keep their own size; the slider edits the one in use
  const toolSizes = { brush: 8, eraser: 30 };
  let strokeRenderer = null;

  const activePointers = new Map();
  let mode = 'idle';
  let drawPointerId = null;
  let fillPointerId = null;
  let fillDownPoint = null;
  let navIds = [];
  let navPrev = null;

  // { regions: [{ path, mode }], outline } in document space — 'add'
  // regions joined, 'sub' ones cut out; outline: the resulting shape's
  // boundary loops (what's shown). Without a floating fragment it's a
  // draft: nothing lifted until confirmed (✓).
  let selection = null;
  let lassoMode = 'add'; // what the next outline does to a draft
  // tween set-up, open while a lifted piece is being placed at its end
  // position: { frames, easing, bend: {x,y}, preview: t | null }. bend: how
  // far the path's midpoint is pulled off the straight line (doc units);
  // preview: the time (0…1) of the frame the ▶ playback is showing;
  // path: a trajectory through points (doc, sampled densely, from the
  // start A) instead of the arc; waypoints: the points it was made from;
  // editingPath: points being placed — { points } — applied on Готово
  let tweenEdit = null;
  let wpPointerId = null;
  let wpIndex = -1; // the point being dragged, or -1: a tap that may add one
  let wpGrab = null; // finger-to-point offset (drag) / where the tap went down (client)
  let tweenPlayTimer = null;
  let motionEdit = null; // the movement opened again for changes (see editMotion)
  let bendPointerId = null;
  let bendGrab = null; // finger-to-handle offset at the start of a bend drag
  let clipboard = null; // { canvas, x, y, w, h } in layer pixel space

  let lassoPointerId = null;
  let lassoPoints = [];

  // line through points (the poly tool): taps place points (doc), a point
  // can be dragged; ✓ draws the line with the brush's color and size —
  // through them smoothly, or straight from point to point (corners)
  let polyPoints = [];
  let polyRound = true;
  try {
    polyRound = localStorage.getItem('artist-poly-mode') !== 'corners';
  } catch {
    // storage unavailable — default
  }
  let polyPointerId = null;
  let polyIndex = -1; // the point under the finger
  let polyGrab = null; // { dx, dy } finger-to-point, start (client), added: a new point

  let moveSelPointerId = null;
  let moveDragStartDoc = null;

  let floatingFragment = null; // { canvas, x, y, w, h } in layer pixel space, extracted at lift time
  let floatingLayer = null; // the Layer object the fragment was lifted from / will drop onto
  let floatingFrame = null; // the Frame it drops back onto — pinned resident until then
  let floatingPasted = false; // came from the clipboard, not lifted off floatingFrame
  let floatingOffset = { x: 0, y: 0 }; // committed doc-space offset from extraction position
  let floatingScale = 1; // committed scale
  let floatingRotation = 0; // committed rotation, radians
  let dragDelta = { x: 0, y: 0 }; // live, uncommitted single-finger drag offset

  let transformIds = [];
  let transformPrev = null;
  let liveOffset = { x: 0, y: 0 }; // live, uncommitted two-finger pan
  let liveScale = 1; // live, uncommitted two-finger scale
  let liveRotation = 0; // live, uncommitted two-finger rotation

  // transform (the frame with handles): the piece's four corners in
  // document units — TL, TR, BR, BL — while it's on; null otherwise
  let warp = null;
  let warpGrab = null; // one finger: { id, kind: 'corner' | 'edge' | 'move', index, startDoc, startQuad }
  let warpTwo = null; // two fingers: { ids, a, b (doc points at the start), startQuad }

  let cachedCenter = { x: 0, y: 0 };

  function applyView() {
    layerStack.style.transform = view.cssTransform();
    display.invalidate();
    redrawOverlay();
  }

  // the selection overlay is a plain picture of the current view
  function redrawOverlay() {
    drawSelectionOutline();
    if (mode === 'lasso' && lassoPoints.length) drawLassoInProgress();
  }

  function refreshViewportCenter() {
    const rect = canvasWrap.getBoundingClientRect();
    cachedCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    // the picture is the size of the canvas area
    if (display.resize()) redrawOverlay();
    return rect;
  }

  function viewportCenter() {
    return cachedCenter;
  }

  // the timeline lies over the bottom of the canvas area — fit the camera
  // into the part above it
  function timelineHeight() {
    return timelineBarEl.classList.contains('collapsed') ? 0 : timelineBarEl.offsetHeight;
  }

  function fitView() {
    const rect = refreshViewportCenter();
    const tl = Math.min(timelineHeight(), rect.height / 2);
    view.fitTo(rect.width, rect.height - tl);
    view.panY = -tl / 2;
    applyView();
  }

  // bars over the canvas (selection, tween, placing) keep above the timeline
  const syncTimelineHeight = () => document.getElementById('app').style.setProperty('--timeline-h', `${timelineHeight()}px`);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncTimelineHeight).observe(timelineBarEl);
  syncTimelineHeight();

  function updateHistoryButtons() {
    const lifted = Boolean(floatingFragment);
    undoBtn.disabled = lifted || history.undoStack.length === 0;
    redoBtn.disabled = lifted || history.redoStack.length === 0;
    updateMotionBtn(); // a movement's frame drawn on: it can give the movement a new look
    scheduleSave();
  }

  // a draft shows the +/− mode, ✕ and ✓ (lift); a lifted piece copy, cut,
  // tween, ✕ (put back) and ✓ (done)
  function updateSelectionBar() {
    const floating = Boolean(floatingFragment);
    const draft = Boolean(selection) && !floating;
    for (const b of [copySelBtn, cutSelBtn, flipHSelBtn, flipVSelBtn, warpSelBtn, tweenBtn, makeObjectBtn]) {
      // (while transforming: only ✕ and ✓)
      const show = floating && !warp && !(b === warpSelBtn && motionEdit);
      b.disabled = !show;
      b.style.display = show ? '' : 'none';
    }
    selModeBtn.style.display = draft ? '' : 'none';
    setIcon(selModeBtn, lassoMode === 'sub' ? 'squares-subtract' : 'squares-unite');
    selModeBtn.classList.toggle('sub', lassoMode === 'sub');
    selModeBtn.title = lassoMode === 'sub'
      ? 'Следующая обводка вычитает из выделения (нажмите — добавляет)'
      : 'Следующая обводка добавляет к выделению (нажмите — вычитает)';
    deselectSelBtn.disabled = !(floating || draft);
    cancelSelBtn.disabled = !(floating || draft);
    deselectSelBtn.title = warp ? 'Применить трансформацию' : floating ? 'Готово' : 'Выделить';
    cancelSelBtn.title = warp ? 'Отменить трансформацию' : floating ? 'Отмена — вернуть как было' : 'Убрать контур';
    pasteBtn.disabled = !clipboard;
    updateMotionBtn();
    tweenBarOkBtn.title = motionEdit ? 'Пересоздать кадры движения' : 'Создать кадры';
    tweenBarCancelBtn.title = motionEdit ? 'Закрыть — движение как было' : 'Назад к выделению';
    selectionBarEl.classList.toggle('show', (floating || draft) && !tweenEdit);
    const editingPath = floating && Boolean(tweenEdit?.editingPath);
    tweenBarEl.classList.toggle('show', floating && Boolean(tweenEdit) && !editingPath);
    pathBarEl.classList.toggle('show', editingPath);
    if (editingPath) pathUndoBtn.disabled = tweenEdit.editingPath.points.length <= 1;
    if (tweenEdit) {
      tweenCountEl.textContent = String(tweenEdit.frames);
      tweenFewerBtn.disabled = tweenEdit.frames <= 2;
      tweenMoreBtn.disabled = tweenEdit.frames >= 60;
      tweenEaseBtn.textContent = EASINGS.find(e => e.id === tweenEdit.easing)?.label ?? '';
      tweenPathBtn.classList.toggle('active', Boolean(tweenEdit.path));
      tweenPathBtn.title = tweenEdit.path ? 'Изменить путь по точкам' : 'Путь по точкам';
    }
  }

  function flashBtn(btn) {
    btn.classList.remove('flash');
    void btn.offsetWidth; // restart animation if triggered again quickly
    btn.classList.add('flash');
  }

  function setLayersPanelOpen(open) {
    layersPanelEl.classList.toggle('open', open);
    layersBackdropEl.classList.toggle('show', open);
  }

  function docPointFromEvent(e) {
    const p = view.screenToDocument(e.clientX, e.clientY, viewportCenter());
    let pressure = e.pressure;
    if (pressure === 0 || pressure === undefined) pressure = 0.5;
    pressure = Math.max(0.35, pressure);
    return { x: p.x, y: p.y, pressure };
  }

  function hexToRgba(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      255,
    ];
  }

  // --- selection: lift on select, float above everything, drop on deselect/switch ---

  function currentOffset() {
    return {
      x: floatingOffset.x + dragDelta.x + liveOffset.x,
      y: floatingOffset.y + dragDelta.y + liveOffset.y,
    };
  }

  function currentScale() {
    return floatingScale * liveScale;
  }

  function currentRotation() {
    return floatingRotation + liveRotation;
  }

  function fragmentCenterDoc() {
    const dpr = floatingLayer.dpr || 1;
    return {
      x: floatingFragment.x / dpr + floatingFragment.w / dpr / 2,
      y: floatingFragment.y / dpr + floatingFragment.h / dpr / 2,
    };
  }

  // the selection's outline loops as shown: a draft's as computed, a
  // lifted one's moved / scaled / turned along with the fragment
  function transformedOutline() {
    if (!selection) return null;
    if (!floatingFragment) return selection.outline;
    const center = fragmentCenterDoc();
    const scale = currentScale();
    const rot = currentRotation();
    const o = currentOffset();
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return selection.outline.map(path => path.map(p => {
      const dx = (p.x - center.x) * scale;
      const dy = (p.y - center.y) * scale;
      return {
        x: center.x + (dx * cos - dy * sin) + o.x,
        y: center.y + (dx * sin + dy * cos) + o.y,
      };
    }));
  }

  const SUB_OUTLINE = '#e11d48';

  // ---- tween path: start A (where the piece was lifted), end B (where it
  // is now), a quadratic curve between them bent through its midpoint ----

  function tweenEnds() {
    const center = fragmentCenterDoc();
    const o = currentOffset();
    return { center, A: { x: center.x, y: center.y }, B: { x: center.x + o.x, y: center.y + o.y } };
  }

  // the on-curve midpoint (the bend handle)
  function tweenMid(A, B) {
    const bend = tweenEdit?.bend ?? { x: 0, y: 0 };
    return { x: (A.x + B.x) / 2 + bend.x, y: (A.y + B.y) / 2 + bend.y };
  }

  // where along a drawn path fraction u (0…1, by length) falls; the path
  // is pulled along with the piece's end: its end follows B, more so the
  // farther along (the start stays at A)
  function drawnPathAt(path, u, B) {
    const lens = [0];
    for (let i = 1; i < path.length; i++) lens.push(lens[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    const total = lens[lens.length - 1] || 1;
    const want = u * total;
    let i = 1;
    while (i < path.length - 1 && lens[i] < want) i++;
    const f = Math.max(0, Math.min(1, (want - lens[i - 1]) / ((lens[i] - lens[i - 1]) || 1)));
    const end = path[path.length - 1];
    return {
      x: path[i - 1].x + (path[i].x - path[i - 1].x) * f + (B.x - end.x) * u,
      y: path[i - 1].y + (path[i].y - path[i - 1].y) * f + (B.y - end.y) * u,
    };
  }

  // the piece's placement at path fraction u (0 = A, 1 = B), as an
  // offset / scale / rotation from where it was lifted. opts: { bend, path }
  // (the tween set-up's, unless given)
  function tweenAt(u, opts = tweenEdit) {
    const { center, A, B } = tweenEnds();
    let x, y;
    if (opts?.path) {
      ({ x, y } = drawnPathAt(opts.path, u, B));
    } else {
      const b = opts?.bend ?? { x: 0, y: 0 };
      const M = { x: (A.x + B.x) / 2 + b.x, y: (A.y + B.y) / 2 + b.y };
      // control point of the quadratic passing through M at u = 0.5
      const C = { x: 2 * M.x - (A.x + B.x) / 2, y: 2 * M.y - (A.y + B.y) / 2 };
      const v = 1 - u;
      x = v * v * A.x + 2 * v * u * C.x + u * u * B.x;
      y = v * v * A.y + 2 * v * u * C.y + u * u * B.y;
    }
    return {
      offset: { x: x - center.x, y: y - center.y },
      scale: 1 + (currentScale() - 1) * u,
      rotation: currentRotation() * u,
    };
  }

  // path, start ghost, the in-between positions, preview, bend handle
  function drawTweenGuides() {
    const { center, A, B } = tweenEnds();
    const dpr = floatingLayer.dpr || 1;
    const frag = floatingFragment;
    const ease = EASING_FNS[tweenEdit.easing] || EASING_FNS.linear;
    const n = tweenEdit.frames;
    const path = [];
    for (let i = 0; i <= 120; i++) {
      const o = tweenAt(i / 120).offset;
      path.push({ x: center.x + o.x, y: center.y + o.y });
    }
    overlay.strokeBand(path, 'rgba(74, 125, 255, 0.35)', 10);
    const ghost = (t, alpha) => {
      const p = tweenAt(t);
      overlay.drawFragmentTransformed(frag.canvas, center.x + p.offset.x, center.y + p.offset.y, frag.w / dpr, frag.h / dpr, p.scale, p.rotation, alpha * floatingLayer.opacity);
    };
    // where it starts, and every frame in between (at most ~20 of them)
    ghost(0, 0.45);
    const step = Math.max(1, Math.ceil((n - 2) / 20));
    for (let i = 1; i < n - 1; i += step) ghost(ease(i / (n - 1)), 0.18);
    for (let i = 0; i < n; i++) {
      const o = tweenAt(ease(i / (n - 1))).offset;
      overlay.dot(center.x + o.x, center.y + o.y, 3.5, i === 0 ? '#fff' : '#4a7dff', '#1d3d99');
    }
    if (tweenEdit.preview != null) ghost(ease(tweenEdit.preview), 0.85);
    if (bendHandleShown()) {
      const M = tweenMid(A, B);
      overlay.dot(M.x, M.y, 9, 'rgba(255, 255, 255, 0.9)', '#4a7dff');
    }
  }

  // the bend handle only once the ends are apart — until then it would sit
  // right on the piece and catch the finger meant to drag it
  function bendHandleShown() {
    if (tweenEdit?.path || tweenEdit?.editingPath) return false; // a path through points has no arc to bend
    const { A, B } = tweenEnds();
    return Math.hypot(B.x - A.x, B.y - A.y) * view.scale > 60;
  }

  function nearBendHandle(docPt) {
    if (!tweenEdit || !bendHandleShown()) return false;
    const { A, B } = tweenEnds();
    const M = tweenMid(A, B);
    return Math.hypot(docPt.x - M.x, docPt.y - M.y) * view.scale <= 24;
  }

  function drawSelectionOutline() {
    overlay.clear();
    overlay.tint = floatingLayer ? layerManager.tintOf(floatingLayer) : null;
    if (activeObject() && !floatingFragment) {
      if (!playTimer) drawObjectGuides();
      return;
    }
    if (tool === 'poly') {
      drawPolyPreview();
      return;
    }
    if (floatingFragment && tweenEdit?.editingPath) {
      // placing path points: the piece is shown at the start, where the
      // path begins — not wherever it had been dragged to
      drawPathEditor();
      return;
    }
    if (floatingFragment && warp) {
      drawWarpFrame();
      return;
    }
    if (floatingFragment && tweenEdit) drawTweenGuides();
    if (floatingFragment) {
      const dpr = floatingLayer.dpr || 1;
      const center = fragmentCenterDoc();
      const o = currentOffset();
      overlay.drawFragmentTransformed(
        floatingFragment.canvas,
        center.x + o.x,
        center.y + o.y,
        floatingFragment.w / dpr,
        floatingFragment.h / dpr,
        currentScale(),
        currentRotation(),
        // looks like it does on its layer: a see-through layer's piece stays see-through
        floatingLayer.opacity,
      );
    }
    const loops = transformedOutline();
    if (!loops?.length) return;
    // a draft's area tinted, so inside / outside reads at a glance
    if (!floatingFragment) overlay.fillLoops(loops, 'rgba(74, 125, 255, 0.14)');
    for (const path of loops) overlay.strokeDashedPath(path, true);
  }

  // the outline being drawn right now, on top of the draft
  function drawLassoInProgress() {
    const sub = Boolean(selection) && !floatingFragment && lassoMode === 'sub';
    overlay.strokeDashedPath(lassoPoints, false, sub ? SUB_OUTLINE : '#000');
  }

  function isInsideSelection(docPt) {
    if (!floatingFragment) return false;
    const loops = transformedOutline();
    if (!loops?.length) return false;
    return loops.some(path => {
      const box = pathBoundingBox(path);
      return docPt.x >= box.x && docPt.x <= box.x + box.w &&
        docPt.y >= box.y && docPt.y <= box.y + box.h;
    });
  }

  function liftSelection(layer, regions) {
    if (!history.begin(layer, layer.currentFrameIndex)) return false;
    // the cut-out area is what changes
    history.touch(regionsRectPx(regions, layer.dpr));
    const frag = extractRegions(layer.currentFrame, regions, layer.dpr);
    if (!frag) {
      history.cancelPending();
      return false;
    }
    floatingFragment = frag;
    floatingLayer = layer;
    floatingPasted = false;
    pinFloatingFrame(layer.currentFrame);
    floatingOffset = { x: 0, y: 0 };
    floatingScale = 1;
    floatingRotation = 0;
    dragDelta = { x: 0, y: 0 };
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
    clearMaskArea(layer.currentFrame, frag);
    return true;
  }

  function pinFloatingFrame(frame) {
    floatingFrame = frame;
    frame.pins++;
  }

  function unpinFloatingFrame() {
    if (floatingFrame) floatingFrame.pins--;
    floatingFrame = null;
  }

  function dropFloating() {
    if (motionEdit) {
      exitMotionEdit();
      return;
    }
    if (!floatingFragment) return;
    if (warp) applyWarp(); // dropped mid-transform (tool switch, leaving…): as it's shown
    const layer = floatingLayer;
    const dpr = layer.dpr || 1;
    const o = currentOffset();
    const scale = currentScale();
    const rot = currentRotation();
    const center = fragmentCenterDoc();

    // onto the frame it was lifted from, even if the playhead moved since
    const area = fragmentRectPx(layer, [{ center, offset: o, scale }]);
    history.touch(area);
    const frag = floatingFragment;
    floatingFrame.drawWith(area, (ctx, ox, oy) => {
      drawFragmentOnContext(ctx, frag, center, { offset: o, scale, rotation: rot }, dpr, { x: ox, y: oy });
    });

    history.commit();
    layersPanel.refreshThumbnail(layer);
    timeline.refreshThumbnail(layer, layer.frames.indexOf(floatingFrame));

    unpinFloatingFrame();
    floatingFragment = null;
    floatingLayer = null;
    floatingOffset = { x: 0, y: 0 };
    floatingScale = 1;
    floatingRotation = 0;
    dragDelta = { x: 0, y: 0 };
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
  }

  // ✕ on the selection bar: put everything back as it was before the lift
  // (a pasted piece just goes away) — nothing is recorded
  function cancelSelection() {
    if (motionEdit) {
      exitMotionEdit();
      return;
    }
    if (warp) {
      // ✕ while transforming: the piece as it was before the frame came up
      endWarp();
      return;
    }
    stopTweenPlay();
    tweenEdit = null;
    if (!floatingFragment) {
      // a draft: just forget the outlines
      selection = null;
      lassoMode = 'add';
      overlay.clear();
      updateSelectionBar();
      return;
    }
    const layer = floatingLayer;
    const frame = floatingFrame;
    history.revertPending();
    history.cancelPending();
    unpinFloatingFrame();
    floatingFragment = null;
    floatingLayer = null;
    floatingOffset = { x: 0, y: 0 };
    floatingScale = 1;
    floatingRotation = 0;
    dragDelta = { x: 0, y: 0 };
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
    selection = null;
    overlay.clear();
    layersPanel.refreshThumbnail(layer);
    timeline.refreshThumbnail(layer, layer.frames.indexOf(frame));
    updateSelectionBar();
    updateHistoryButtons();
  }

  function clearSelection() {
    if (motionEdit) {
      exitMotionEdit();
      return;
    }
    stopTweenPlay();
    tweenEdit = null;
    dropFloating();
    selection = null;
    lassoMode = 'add';
    overlay.clear();
    updateSelectionBar();
    updateHistoryButtons();
  }

  function beginLasso(e, docPt) {
    mode = 'lasso';
    lassoPointerId = e.pointerId;
    lassoPoints = [docPt];
    drawSelectionOutline();
  }

  function abortLasso() {
    lassoPointerId = null;
    lassoPoints = [];
    drawSelectionOutline();
  }

  // an outline drawn: added to (or, in − mode, cut out of) the draft —
  // nothing is lifted until ✓
  function finishLasso() {
    if (lassoPoints.length >= 3) {
      if (!selection) selection = { regions: [] };
      // the first outline always adds — there's nothing to cut from yet
      const m = selection.regions.length ? lassoMode : 'add';
      selection.regions.push({ path: lassoPoints, mode: m });
      // the combined shape, right away: joined with what it overlaps, or
      // with this bit cut out
      selection.outline = regionsOutline(selection.regions);
      if (!selection.outline.length) selection = null; // all of it cut away
    }
    lassoPointerId = null;
    lassoPoints = [];
    drawSelectionOutline();
    updateSelectionBar();
  }

  // ✓ on a draft: lift what it outlines off the active layer
  function confirmSelection() {
    if (!selection || floatingFragment) return;
    const layer = layerManager.activeLayer;
    if (layer) ensureFrameHere(layer);
    if (layer && liftSelection(layer, selection.regions)) {
      } else {
      selection = null; // nothing inside (or the frame is still loading)
    }
    lassoMode = 'add';
    drawSelectionOutline();
    updateSelectionBar();
    updateHistoryButtons();
  }

  // ---- object layers (ObjectLayer): a picture moved by key poses ----

  function activeObject() {
    const l = layerManager.activeLayer;
    return l?.kind === 'object' ? l : null;
  }

  // a finger on it (a little around it counts too)
  function objectHit(obj, d) {
    return obj.hit(d, layerManager.playhead, 14 / view.scale);
  }

  // the keys changed by mutate(keys) — one undo step
  function changeKeys(layer, mutate) {
    const before = layer.keys.map(k => ({ ...k }));
    mutate(layer.keys);
    layer.keys.sort((a, b) => a.t - b.t);
    history.recordObject(layer, before, layer.keys.map(k => ({ ...k })));
    layer.syncToTime(layerManager.playhead);
    timeline.render();
    drawSelectionOutline();
    updateObjectBar();
    updateHistoryButtons();
  }

  // pose: where the object is at tick t from now on — the key there, or a
  // new one (moving on to the next key the way the one before it did)
  function setObjectKey(layer, t, pose) {
    const p = { x: pose.x, y: pose.y, scale: pose.scale, rotation: pose.rotation };
    changeKeys(layer, keys => {
      const k = keys.find(q => q.t === t);
      if (k) {
        Object.assign(k, p);
        return;
      }
      const prev = keys.filter(q => q.t < t).pop() ?? keys[0];
      keys.push({ t, ...p, ease: prev?.ease ?? 'easeInOut' });
    });
  }

  // its path (every tick of its span), its keys, its box now
  function drawObjectGuides() {
    const obj = activeObject();
    const t = layerManager.playhead;
    const pts = [];
    for (let u = obj.firstTick; u < obj.totalDuration; u++) {
      const p = obj.poseAt(u);
      pts.push({ x: p.x, y: p.y });
    }
    if (pts.length >= 2) overlay.strokeBand(pts, 'rgba(168, 85, 247, 0.35)', 6);
    for (let u = obj.firstTick; u < obj.totalDuration; u++) {
      if (obj.keyAt(u)) continue;
      const p = obj.poseAt(u);
      overlay.dot(p.x, p.y, 2.5, 'rgba(168, 85, 247, 0.8)');
    }
    for (const k of obj.keys) overlay.dot(k.x, k.y, 6, k.t === t ? '#fbbf24' : '#e9d5ff', '#7e3fd0');
    overlay.strokeDashedPath(obj.outlineAt(t), true, '#7e3fd0');
  }

  function updateObjectBar() {
    const obj = activeObject();
    const show = Boolean(obj) && !playTimer && !floatingFragment;
    objectBarEl.classList.toggle('show', show);
    if (!show) return;
    const t = layerManager.playhead;
    const key = obj.keyAt(t);
    const last = obj.keys[obj.keys.length - 1];
    const drawing = tool === 'brush' || tool === 'eraser';
    objectHintEl.textContent = drawing
      ? 'Рисуете на объекте — двигать: лассо'
      : key ? 'Ключ' : 'Сдвиньте объект — тут будет ключ';
    objectEaseBtn.style.display = key && key !== last ? '' : 'none';
    if (key) objectEaseBtn.textContent = EASINGS.find(e => e.id === key.ease)?.label ?? '';
    objectDelKeyBtn.style.display = key ? '' : 'none';
    objectDelKeyBtn.disabled = !key || obj.keys.length <= 1;
  }

  objectEaseBtn.addEventListener('click', () => {
    const obj = activeObject();
    const key = obj?.keyAt(layerManager.playhead);
    if (!key) return;
    const i = EASINGS.findIndex(e => e.id === key.ease);
    const next = EASINGS[(i + 1) % EASINGS.length].id;
    changeKeys(obj, keys => { keys.find(k => k.t === key.t).ease = next; });
  });
  objectDelKeyBtn.addEventListener('click', () => {
    const obj = activeObject();
    const t = layerManager.playhead;
    if (!obj?.keyAt(t) || obj.keys.length <= 1) return;
    changeKeys(obj, keys => keys.splice(keys.findIndex(k => k.t === t), 1));
  });
  objectBarEl.addEventListener('pointerdown', e => e.stopPropagation());

  // { id, start: pose, doc } one finger / { ids, start, c, dist, angle } two
  let objGesture = null;

  // ---- drawing on an object: the brush / eraser paint its picture, so it
  // changes at every moment of its movement at once ----

  // its picture as a canvas that can be drawn on (opened: a decoded bitmap)
  function objectCanvas(obj) {
    const p = obj.piece;
    if (!p.canvas) return null;
    if (!(p.canvas instanceof HTMLCanvasElement)) {
      const c = document.createElement('canvas');
      c.width = p.canvas.width;
      c.height = p.canvas.height;
      c.getContext('2d').drawImage(p.canvas, 0, 0);
      p.canvas.close?.();
      p.canvas = c;
    }
    return p.canvas;
  }

  function pieceSnapshot(obj) {
    const src = obj.piece.canvas;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return { canvas: c, w: obj.piece.w, h: obj.piece.h, keys: obj.keys.map(k => ({ ...k })) };
  }

  const MAX_PIECE_PX = 4096;

  // a stroke's piece reaching past the picture: the picture grows (by a
  // margin, so it doesn't on every piece). Its centre moves — every key
  // moves with it, so the object stays where it is on screen.
  // box: in the stroke's space (the picture's units, from its top left
  // when the stroke began); od: the stroke's state ({ ox, oy }: where that
  // top left is now)
  function growPiece(obj, od, box) {
    const p = obj.piece;
    const k = p.canvas.width / p.w; // pixels per unit
    const m = 192 / k;
    const L = box.x0 + od.ox < 0 ? -(box.x0 + od.ox) + m : 0;
    const T = box.y0 + od.oy < 0 ? -(box.y0 + od.oy) + m : 0;
    const R = box.x1 + od.ox > p.w ? box.x1 + od.ox - p.w + m : 0;
    const B = box.y1 + od.oy > p.h ? box.y1 + od.oy - p.h + m : 0;
    if (!L && !T && !R && !B) return;
    const w = p.w + L + R;
    const h = p.h + T + B;
    if (Math.max(w, h) * k > MAX_PIECE_PX) return; // big enough: the rest is cut off
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * k);
    c.height = Math.ceil(h * k);
    c.getContext('2d').drawImage(p.canvas, Math.round(L * k), Math.round(T * k));
    releaseCanvas(p.canvas);
    p.canvas = c;
    p.w = c.width / k;
    p.h = c.height / k;
    const sx = (R - L) / 2;
    const sy = (B - T) / 2;
    for (const key of obj.keys) {
      const cos = Math.cos(key.rotation) * key.scale;
      const sin = Math.sin(key.rotation) * key.scale;
      key.x += sx * cos - sy * sin;
      key.y += sx * sin + sy * cos;
    }
    od.ox += Math.round(L * k) / k;
    od.oy += Math.round(T * k) / k;
  }

  let objDraw = null; // { obj, id, before, toLocal, scale, ox, oy, renderer }

  function beginObjectDraw(e) {
    const obj = activeObject();
    const canvas = objectCanvas(obj);
    if (!canvas) {
      obj.ready().then(() => display.invalidate()).catch(() => {});
      mode = 'picked';
      return;
    }
    const pose = { ...obj.poseAt(layerManager.playhead) };
    const cos = Math.cos(-pose.rotation);
    const sin = Math.sin(-pose.rotation);
    const w0 = obj.piece.w;
    const h0 = obj.piece.h;
    // document point -> the picture's units, from its top left (as it was
    // when the stroke began)
    const toLocal = d => {
      const dx = d.x - pose.x;
      const dy = d.y - pose.y;
      return { x: (dx * cos - dy * sin) / pose.scale + w0 / 2, y: (dx * sin + dy * cos) / pose.scale + h0 / 2, pressure: d.pressure };
    };
    const erase = tool === 'eraser';
    const strokeColor = color;
    const od = { obj, id: e.pointerId, before: pieceSnapshot(obj), toLocal, scale: pose.scale, ox: 0, oy: 0 };
    od.renderer = new StrokeRenderer((box, draw) => {
      if (!erase) growPiece(obj, od, box);
      const p = obj.piece;
      const k = p.canvas.width / p.w;
      const ctx = p.canvas.getContext('2d');
      ctx.save();
      ctx.setTransform(k, 0, 0, k, od.ox * k, od.oy * k);
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
      ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      draw(ctx);
      ctx.restore();
      display.invalidate();
    });
    objDraw = od;
    mode = 'objDraw';
    od.renderer.begin(toLocal(docPointFromEvent(e)), size / pose.scale);
    trackDrawRing(e);
  }

  function moveObjectDraw(e) {
    const samples = e.getCoalescedEvents?.() ?? [];
    for (const ev of samples.length ? samples : [e]) objDraw.renderer.extend(objDraw.toLocal(docPointFromEvent(ev)), size / objDraw.scale);
    trackDrawRing(e);
  }

  function endObjectDraw() {
    const { obj, before, renderer } = objDraw;
    renderer.end();
    objDraw = null;
    updateHoverRing();
    obj.piece.dirty = true;
    history.recordObjectPiece(obj, before, pieceSnapshot(obj));
    layersPanel.refreshThumbnail(obj);
    timeline.render();
    drawSelectionOutline();
    updateHistoryButtons();
  }

  // a second finger: it was a zoom — the picture as it was
  function abortObjectDraw() {
    const { obj, before } = objDraw;
    objDraw = null;
    updateHoverRing();
    Object.assign(obj.piece, { canvas: before.canvas, w: before.w, h: before.h });
    obj.keys = before.keys;
    display.invalidate();
  }

  function beginObjectMove(e) {
    const obj = activeObject();
    const d = docPointFromEvent(e);
    if (!objectHit(obj, d)) {
      mode = 'picked'; // a touch beside it does nothing
      return;
    }
    mode = 'objMove';
    objGesture = { id: e.pointerId, start: { ...obj.poseAt(layerManager.playhead) }, doc: d, moved: false };
    obj.time = layerManager.playhead;
  }

  function moveObject(e) {
    const obj = activeObject();
    const d = docPointFromEvent(e);
    const g = objGesture;
    if (!g.moved && Math.hypot(d.x - g.doc.x, d.y - g.doc.y) * view.scale < 4) return;
    g.moved = true;
    obj.livePose = { ...g.start, x: g.start.x + d.x - g.doc.x, y: g.start.y + d.y - g.doc.y };
    display.invalidate();
    drawSelectionOutline();
  }

  function beginObjectTransform(ids) {
    const obj = activeObject();
    if (mode === 'objMove') abortObjectGesture();
    const [a, b] = ids.map(id => activePointers.get(id));
    mode = 'objTransform';
    const start = { ...obj.poseAt(layerManager.playhead) };
    objGesture = { ids, start, c: docPointFromEvent({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }), dist: distance(a, b), angle: angle(a, b), moved: true };
    obj.time = layerManager.playhead;
  }

  function transformObject() {
    const obj = activeObject();
    const g = objGesture;
    const [a, b] = g.ids.map(id => activePointers.get(id));
    if (!a || !b) return;
    const c = docPointFromEvent({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
    obj.livePose = {
      x: g.start.x + c.x - g.c.x,
      y: g.start.y + c.y - g.c.y,
      scale: Math.max(0.02, g.start.scale * (distance(a, b) / (g.dist || 1))),
      rotation: g.start.rotation + angle(a, b) - g.angle,
    };
    display.invalidate();
    drawSelectionOutline();
  }

  function endObjectGesture() {
    const obj = activeObject();
    const pose = obj?.livePose;
    if (obj) obj.livePose = null;
    const moved = objGesture?.moved;
    objGesture = null;
    if (obj && pose && moved) setObjectKey(obj, layerManager.playhead, pose);
    display.invalidate();
  }

  function abortObjectGesture() {
    const obj = activeObject();
    if (obj) obj.livePose = null;
    objGesture = null;
    display.invalidate();
  }

  // the lifted piece becomes an object layer right over its layer: it
  // leaves the frame (a pasted one: nothing to leave), with a key now and
  // one a second later where it is — move it at another moment for a
  // movement. Making the layer isn't undoable (as adding one isn't); the
  // cut out of the frame is.
  async function makeObjectFromSelection() {
    if (!floatingFragment || motionEdit) return;
    const layer = floatingLayer;
    const dpr = layer.dpr || 1;
    const frag = floatingFragment;
    const center = fragmentCenterDoc();
    const o = currentOffset();
    const pose = { x: center.x + o.x, y: center.y + o.y, scale: currentScale(), rotation: currentRotation(), ease: 'easeInOut' };
    const piece = { canvas: frag.canvas, blob: await encodeCanvas(frag.canvas, 'png'), w: frag.w / dpr, h: frag.h / dpr };
    if (floatingPasted) history.cancelPending();
    else history.commit();
    stopTweenPlay();
    tweenEdit = null;
    unpinFloatingFrame();
    floatingFragment = null;
    floatingLayer = null;
    floatingOffset = { x: 0, y: 0 };
    floatingScale = 1;
    floatingRotation = 0;
    dragDelta = { x: 0, y: 0 };
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
    selection = null;
    lassoMode = 'add';
    const t = layerManager.playhead;
    layerManager.addObjectLayer('Объект', { piece, keys: [{ t, ...pose }, { t: t + 12, ...pose }] }, { above: layer });
    layersPanel.render();
    layersPanel.refreshThumbnail(layer);
    timeline.render();
    renderOnionSkin();
    updateSelectionBar();
    updateHistoryButtons();
    drawSelectionOutline();
  }
  makeObjectBtn.addEventListener('click', () => makeObjectFromSelection());

  // ---- line through points (poly tool) ----

  // the line as a dense polyline (closed: back round to the first point)
  function polyPath(closed = false) {
    const pts = polyPoints;
    if (!polyRound || pts.length < 3) return closed ? [...pts, pts[0]] : pts.map(p => ({ ...p }));
    if (!closed) return splineThrough(pts, 20);
    // round the corner at the first point too: spline through the loop
    // with a neighbour on either side, keep the part from p0 back to p0
    const n = pts.length;
    const per = 20;
    const out = splineThrough([pts[n - 1], ...pts, pts[0], pts[1]], per);
    return out.slice(per, (n + 1) * per + 1);
  }

  // as thick as the brush draws at this size (a finger stroke: the size ×
  // its pressure, as the brush ring shows it)
  function polyWidth() {
    return Math.max(0.5, size * lastPressure);
  }

  function strokePolyline(ctx, pts, closed, width, strokeColor) {
    ctx.lineWidth = width;
    ctx.strokeStyle = strokeColor;
    ctx.lineCap = 'round';
    ctx.lineJoin = polyRound ? 'round' : 'miter';
    ctx.miterLimit = 4;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  function drawPolyPreview() {
    if (!polyPoints.length) return;
    if (polyPoints.length >= 2) {
      const ctx = overlay.ctx;
      ctx.save();
      ctx.globalAlpha = 0.85;
      strokePolyline(ctx, polyPath(), false, polyWidth(), color);
      ctx.restore();
    }
    polyPoints.forEach((p, i) => overlay.dot(p.x, p.y, i === 0 ? 8 : 7, i === 0 ? '#4a7dff' : '#fff', i === 0 ? '#fff' : '#4a7dff'));
  }

  function updatePolyBar() {
    const on = tool === 'poly';
    polyBarEl.classList.toggle('show', on);
    polyBtn.classList.toggle('active', on);
    if (!on) return;
    const n = polyPoints.length;
    polyHintEl.textContent = n === 0 ? 'Тап — точка' : n === 1 ? 'Ещё точка' : n >= 3 ? 'Тап по первой — замкнуть' : '';
    polyHintEl.style.display = polyHintEl.textContent ? '' : 'none';
    polyModeBtn.textContent = polyRound ? 'Плавно' : 'Углы';
    polyModeBtn.title = polyRound ? 'Скруглённая линия (нажмите — с уголками)' : 'Линия с уголками (нажмите — скруглённая)';
    polyUndoBtn.disabled = n === 0;
    polyCancelBtn.disabled = n === 0;
    polyDoneBtn.disabled = n < 2;
  }

  function polyPointAt(docPt) {
    for (let i = polyPoints.length - 1; i >= 0; i--) {
      const p = polyPoints[i];
      if (Math.hypot(docPt.x - p.x, docPt.y - p.y) * view.scale <= WAYPOINT_HIT) return i;
    }
    return -1;
  }

  // a touch: on a point — drag it; elsewhere — a new point there, once
  // it's clear this is one finger (it lifts, or moves on its own): the
  // first finger of a two-finger zoom mustn't flash a line to it
  function beginPolyPoint(e, docPt) {
    mode = 'poly';
    polyPointerId = e.pointerId;
    polyIndex = polyPointAt(docPt);
    const p = polyIndex >= 0 ? polyPoints[polyIndex] : docPt;
    polyGrab = { dx: p.x - docPt.x, dy: p.y - docPt.y, x: e.clientX, y: e.clientY, down: docPt, added: false, moved: false };
  }

  function movePolyPoint(e) {
    if (Math.hypot(e.clientX - polyGrab.x, e.clientY - polyGrab.y) > 6) polyGrab.moved = true;
    if (!polyGrab.moved) return;
    const d = docPointFromEvent(e);
    if (polyIndex < 0) {
      polyPoints.push({ x: d.x, y: d.y });
      polyIndex = polyPoints.length - 1;
      polyGrab.added = true;
      updatePolyBar();
    }
    polyPoints[polyIndex] = { x: d.x + polyGrab.dx, y: d.y + polyGrab.dy };
    drawSelectionOutline();
  }

  function endPolyPoint() {
    // a tap on empty canvas: the new point
    if (polyIndex < 0) polyPoints.push({ x: polyGrab.down.x, y: polyGrab.down.y });
    // a tap on the first point closes the line and draws it
    const close = polyIndex === 0 && !polyGrab.moved && polyPoints.length >= 3;
    polyPointerId = null;
    polyIndex = -1;
    polyGrab = null;
    if (close) commitPoly(true);
    updatePolyBar();
    drawSelectionOutline();
  }

  // a second finger: it was a zoom — the point that touch added goes
  function abortPolyPoint() {
    if (polyGrab?.added && polyIndex === polyPoints.length - 1) polyPoints.pop();
    polyPointerId = null;
    polyIndex = -1;
    polyGrab = null;
    updatePolyBar();
    drawSelectionOutline();
  }

  // draws the line on the selected frame — one undo step
  function commitPoly(closed = false) {
    if (polyPoints.length < 2) return;
    const layer = layerManager.activeLayer;
    if (!layer || layer.kind === 'object') return;
    ensureFrameHere(layer);
    // the frame is still decoding: the points stay, ✓ again in a moment
    if (!history.begin(layer, layer.currentFrameIndex)) return;
    const pts = polyPath(closed);
    const width = polyWidth();
    dlog('poly', { size, width: +width.toFixed(2), n: polyPoints.length, round: polyRound, closed });
    const strokeColor = color;
    // miter corners reach out up to miterLimit × half the width
    const m = width * 2 + 2;
    const box = {
      x0: Math.min(...pts.map(p => p.x)) - m, y0: Math.min(...pts.map(p => p.y)) - m,
      x1: Math.max(...pts.map(p => p.x)) + m, y1: Math.max(...pts.map(p => p.y)) + m,
    };
    const rect = dirtyPx(layer, box, 1);
    history.touch(rect);
    layer.currentFrame.drawWith(rect, ctx => strokePolyline(ctx, pts, closed, width, strokeColor));
    history.commit();
    polyPoints = [];
    layersPanel.refreshThumbnail(layer);
    timeline.refreshThumbnail(layer, layer.currentFrameIndex);
    updateHistoryButtons();
    updatePolyBar();
    drawSelectionOutline();
  }

  // ---- path through points: tap adds a point, a point can be dragged,
  // the curve runs smoothly through all of them; Готово applies it ----

  // a centripetal Catmull–Rom spline through pts, as a dense polyline
  function splineThrough(pts, perSegment = 16) {
    if (pts.length < 3) return pts.map(p => ({ ...p }));
    const out = [{ ...pts[0] }];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      const t01 = Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)) || 1e-3;
      const t12 = Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y)) || 1e-3;
      const t23 = Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)) || 1e-3;
      // tangents at p1 and p2 (Barry–Goldman), scaled to the segment
      const m1 = {
        x: (p2.x - p1.x + t12 * ((p1.x - p0.x) / t01 - (p2.x - p0.x) / (t01 + t12))),
        y: (p2.y - p1.y + t12 * ((p1.y - p0.y) / t01 - (p2.y - p0.y) / (t01 + t12))),
      };
      const m2 = {
        x: (p2.x - p1.x + t12 * ((p3.x - p2.x) / t23 - (p3.x - p1.x) / (t12 + t23))),
        y: (p2.y - p1.y + t12 * ((p3.y - p2.y) / t23 - (p3.y - p1.y) / (t12 + t23))),
      };
      for (let k = 1; k <= perSegment; k++) {
        const t = k / perSegment;
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        out.push({
          x: h00 * p1.x + h10 * m1.x + h01 * p2.x + h11 * m2.x,
          y: h00 * p1.y + h10 * m1.y + h01 * p2.y + h11 * m2.y,
        });
      }
    }
    return out;
  }

  const WAYPOINT_HIT = 22; // screen px

  function startPathEdit() {
    const { A } = tweenEnds();
    const saved = tweenEdit.waypoints;
    // the first point is the start — where the piece was lifted
    const points = saved?.length ? saved.map(p => ({ ...p })) : [{ ...A }];
    points[0] = { ...A };
    tweenEdit.editingPath = { points };
    stopTweenPlay();
    updateSelectionBar();
    drawSelectionOutline();
  }

  function finishPathEdit(apply) {
    const pts = tweenEdit.editingPath.points;
    tweenEdit.editingPath = null;
    if (apply) {
      if (pts.length >= 2) {
        const { center } = tweenEnds();
        tweenEdit.waypoints = pts;
        tweenEdit.path = splineThrough(pts);
        const end = pts[pts.length - 1];
        floatingOffset = { x: end.x - center.x, y: end.y - center.y };
        dragDelta = { x: 0, y: 0 };
        liveOffset = { x: 0, y: 0 };
      } else {
        // only the start left: back to a straight line
        tweenEdit.waypoints = null;
        tweenEdit.path = null;
        tweenEdit.bend = { x: 0, y: 0 };
      }
    }
    updateSelectionBar();
    drawSelectionOutline();
  }

  function drawPathEditor() {
    const dpr = floatingLayer.dpr || 1;
    const frag = floatingFragment;
    const pts = tweenEdit.editingPath.points;
    const w = frag.w / dpr;
    const h = frag.h / dpr;
    if (pts.length >= 2) {
      overlay.strokeBand(splineThrough(pts), 'rgba(74, 125, 255, 0.5)', 8);
      // where it will end up, faint
      const end = pts[pts.length - 1];
      overlay.drawFragmentTransformed(frag.canvas, end.x, end.y, w, h, currentScale(), currentRotation(), 0.35 * floatingLayer.opacity);
    }
    // the piece itself, at the start
    overlay.drawFragmentTransformed(frag.canvas, pts[0].x, pts[0].y, w, h, 1, 0, floatingLayer.opacity);
    pts.forEach((p, i) => overlay.dot(p.x, p.y, i === 0 ? 6 : 9, i === 0 ? '#fff' : '#4a7dff', i === 0 ? '#1d3d99' : '#fff'));
  }

  function waypointAt(docPt) {
    const pts = tweenEdit.editingPath.points;
    // the start is fixed; the last ones first (they're on top)
    for (let i = pts.length - 1; i >= 1; i--) {
      if (Math.hypot(docPt.x - pts[i].x, docPt.y - pts[i].y) * view.scale <= WAYPOINT_HIT) return i;
    }
    return -1;
  }

  function beginWaypoint(e, docPt) {
    mode = 'waypoint';
    wpPointerId = e.pointerId;
    wpIndex = waypointAt(docPt);
    wpGrab = wpIndex >= 0
      ? { x: tweenEdit.editingPath.points[wpIndex].x - docPt.x, y: tweenEdit.editingPath.points[wpIndex].y - docPt.y }
      : { x: e.clientX, y: e.clientY };
  }

  function moveWaypoint(e) {
    if (wpIndex < 0) return; // a tap in the making — adds its point on release
    const docPt = docPointFromEvent(e);
    tweenEdit.editingPath.points[wpIndex] = { x: docPt.x + wpGrab.x, y: docPt.y + wpGrab.y };
    drawSelectionOutline();
  }

  function endWaypoint(e) {
    // a tap (not a drag) on empty canvas: a new point at the end
    if (wpIndex < 0 && Math.hypot(e.clientX - wpGrab.x, e.clientY - wpGrab.y) < 12) {
      const p = docPointFromEvent(e);
      tweenEdit.editingPath.points.push({ x: p.x, y: p.y });
    }
    wpPointerId = null;
    wpIndex = -1;
    updateSelectionBar();
    drawSelectionOutline();
  }

  // dragging the tween path's midpoint bends it into an arc
  function beginBend(e, docPt) {
    mode = 'bend';
    bendPointerId = e.pointerId;
    const { A, B } = tweenEnds();
    const M = tweenMid(A, B);
    bendGrab = { x: M.x - docPt.x, y: M.y - docPt.y };
  }

  function updateBend(docPt) {
    const { A, B } = tweenEnds();
    tweenEdit.bend = {
      x: docPt.x + bendGrab.x - (A.x + B.x) / 2,
      y: docPt.y + bendGrab.y - (A.y + B.y) / 2,
    };
    drawSelectionOutline();
  }

  function beginMoveSelection(e, docPt) {
    if (!floatingFragment) return;
    mode = 'moveSel';
    moveSelPointerId = e.pointerId;
    moveDragStartDoc = docPt;
    dragDelta = { x: 0, y: 0 };
  }

  function updateMoveSelection(docPt) {
    dragDelta = { x: docPt.x - moveDragStartDoc.x, y: docPt.y - moveDragStartDoc.y };
    drawSelectionOutline();
  }

  function abortMoveSelection() {
    dragDelta = { x: 0, y: 0 };
    moveSelPointerId = null;
    moveDragStartDoc = null;
    drawSelectionOutline();
  }

  function finishMoveSelection(docPt) {
    dragDelta = { x: docPt.x - moveDragStartDoc.x, y: docPt.y - moveDragStartDoc.y };
    floatingOffset = { x: floatingOffset.x + dragDelta.x, y: floatingOffset.y + dragDelta.y };
    dragDelta = { x: 0, y: 0 };
    moveSelPointerId = null;
    moveDragStartDoc = null;
    drawSelectionOutline();
  }

  // two-finger pinch/rotate/pan applied to the floating selection instead of the canvas view
  function beginTransformSelection() {
    if (mode === 'moveSel') {
      floatingOffset = { x: floatingOffset.x + dragDelta.x, y: floatingOffset.y + dragDelta.y };
      dragDelta = { x: 0, y: 0 };
      moveSelPointerId = null;
      moveDragStartDoc = null;
    } else if (mode === 'transformSel') {
      settleTransformSelection();
    }
    mode = 'transformSel';
    transformIds = Array.from(activePointers.keys()).slice(0, 2);
    const [a, b] = transformIds.map(id => activePointers.get(id));
    transformPrev = { centroid: centroid(a, b), dist: distance(a, b), angle: angle(a, b) };
  }

  function updateTransformSelection() {
    if (transformIds.length < 2) return;
    const [a, b] = transformIds.map(id => activePointers.get(id));
    if (!a || !b) return;

    const curCentroid = centroid(a, b);
    const curDist = distance(a, b);
    const curAngle = angle(a, b);
    const vc = viewportCenter();
    const prevDoc = view.screenToDocument(transformPrev.centroid.x, transformPrev.centroid.y, vc);
    const curDoc = view.screenToDocument(curCentroid.x, curCentroid.y, vc);

    liveScale = Math.min(10, Math.max(0.1, liveScale * (curDist / transformPrev.dist)));
    liveRotation += curAngle - transformPrev.angle;
    liveOffset = {
      x: liveOffset.x + (curDoc.x - prevDoc.x),
      y: liveOffset.y + (curDoc.y - prevDoc.y),
    };

    drawSelectionOutline();

    transformPrev = { centroid: curCentroid, dist: curDist, angle: curAngle };
  }

  function settleTransformSelection() {
    floatingOffset = { x: floatingOffset.x + liveOffset.x, y: floatingOffset.y + liveOffset.y };
    floatingScale = Math.min(10, Math.max(0.1, floatingScale * liveScale));
    floatingRotation += liveRotation;
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
  }

  // makes room on the frame for a stroke point (with slack for the line's
  // width and the curve bulging between samples), then keeps drawing on
  // whatever canvas the frame now has
  // a document-space box (+ margin) as layer pixels
  function dirtyPx(layer, b, margin) {
    const dpr = layer.dpr || 1;
    const x0 = Math.floor((b.x0 - margin) * dpr);
    const y0 = Math.floor((b.y0 - margin) * dpr);
    return { x: x0, y: y0, w: Math.ceil((b.x1 + margin) * dpr) - x0, h: Math.ceil((b.y1 + margin) * dpr) - y0 };
  }

  function beginDraw(e) {
    const layer = layerManager.activeLayer;
    if (!layer) return;
    // the border tool draws on the frame's fill borders, not its picture
    const guide = tool === 'guide';
    // frame still decoding (just switched to it) — ignore this touch
    if (!history.begin(layer, layer.currentFrameIndex, { guide })) return;
    mode = 'draw';
    drawPointerId = e.pointerId;
    const frame = guide ? layer.currentFrame.guideFrame(true) : layer.currentFrame;
    const erase = guide ? guideErase : tool === 'eraser';
    const strokeColor = guide ? GUIDE_COLOR : color;
    const strokeSize = guide ? (guideErase ? toolSizes.eraser : GUIDE_WIDTH) : size;
    // each piece of the stroke: save what's under it for undo, then draw
    // it on every tile it crosses (erasing never adds tiles)
    strokeRenderer = new StrokeRenderer((box, draw) => {
      const rect = dirtyPx(layer, box, 1);
      history.touch(rect);
      frame.drawWith(rect, ctx => {
        ctx.strokeStyle = strokeColor;
        ctx.fillStyle = strokeColor;
        ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        draw(ctx);
      }, { create: !erase });
    });
    strokeRenderer.fixedWidth = guide ? strokeSize : null;
    strokeRenderer.begin(docPointFromEvent(e), strokeSize);
    trackDrawRing(e);
  }

  let strokeMadeFrame = false; // the stroke's touch created a frame (ensureFrameHere)

  function abortDraw() {
    updateHoverRing();
    strokeRenderer?.end();
    strokeRenderer = null;
    drawPointerId = null;
    history.discardPending();
    if (strokeMadeFrame) {
      // it was a zoom, not a stroke: the frame made for it goes again
      strokeMadeFrame = false;
      history.undo(layerManager).then(() => {
        history.redoStack.pop();
        timeline.render();
        updateHistoryButtons();
      });
    }
    const layer = layerManager.activeLayer;
    if (layer) layersPanel.refreshThumbnail(layer);
  }

  function finishDraw() {
    strokeMadeFrame = false; // a real stroke: the frame stays
    updateHoverRing(); // stroke over: back to just the mouse hover ring, if any
    strokeRenderer?.end();
    strokeRenderer = null;
    drawPointerId = null;
    const layer = layerManager.activeLayer;
    history.commit();
    if (layer) {
      layersPanel.refreshThumbnail(layer);
      timeline.refreshThumbnail(layer, layer.currentFrameIndex);
    }
    updateHistoryButtons();
  }

  // where the fill borders of all visible layers' current frames are, over
  // area (layer pixels): a 1 per bordered pixel, or null if there are none
  function guideWalls(area) {
    let walls = null;
    for (const l of layerManager.layers) {
      const g = l.visible ? l.currentFrame?.guide : null;
      if (!g?.resident || g.isBlank) continue;
      const c = g.readRegion(area);
      const d = c.getContext('2d').getImageData(0, 0, area.w, area.h).data;
      releaseCanvas(c);
      for (let i = 0, p = 3; p < d.length; i++, p += 4) {
        if (d[p] > 40) {
          walls ??= new Uint8Array(area.w * area.h);
          walls[i] = 1;
        }
      }
    }
    return walls;
  }

  // A fill works on a copy of the area around the tap: what's drawn on the
  // frame plus the camera (a fill in the open spreads to that edge, not
  // forever), at most a couple of camera sizes across.
  function doFill(e) {
    const layer = layerManager.activeLayer;
    if (!layer) return;
    ensureFrameHere(layer);
    const p = docPointFromEvent(e);
    const dpr = layer.dpr || 1;
    const px = Math.floor(p.x * dpr);
    const py = Math.floor(p.y * dpr);
    if (!history.begin(layer, layer.currentFrameIndex)) return;
    const frame = layer.currentFrame;

    // the camera plus whatever is drawn (on any visible layer, borders too)
    let area = { x: 0, y: 0, w: layer.pixelWidth, h: layer.pixelHeight };
    for (const l of layerManager.layers) {
      if (!l.visible) continue;
      for (const f of [l.currentFrame, l.currentFrame?.guide]) {
        const b = f?.bounds();
        if (!b) continue;
        const x0 = Math.min(area.x, b.x);
        const y0 = Math.min(area.y, b.y);
        area = { x: x0, y: y0, w: Math.max(area.x + area.w, b.x + b.w) - x0, h: Math.max(area.y + area.h, b.y + b.h) - y0 };
      }
    }
    const reach = Math.max(layer.pixelWidth, layer.pixelHeight);
    area = intersectRect(area, { x: px - reach, y: py - reach, w: 2 * reach, h: 2 * reach });
    if (!area || px < area.x || py < area.y || px >= area.x + area.w || py >= area.y + area.h) {
      history.cancelPending();
      return;
    }

    // the area to fill is found on what's on screen — every visible layer
    // (but video ones, they're just reference) plus the fill borders; the
    // paint goes onto this layer only
    const region = frame.readRegion(area);
    const seen = document.createElement('canvas');
    seen.width = area.w;
    seen.height = area.h;
    const sctx = seen.getContext('2d');
    for (const l of layerManager.layers) {
      if (!l.visible || (l !== layer && l.encoding === 'jpeg')) continue;
      if (l === layer) {
        sctx.drawImage(region, 0, 0);
      } else if (l.currentFrame?.resident) {
        const c = l.currentFrame.readRegion(area);
        sctx.drawImage(c, 0, 0);
        releaseCanvas(c);
      }
    }
    const walls = guideWalls(area);
    // creep under a border about half its width, so no seam is left
    const seep = walls ? Math.ceil((GUIDE_WIDTH * dpr) / 2) + 1 : 0;
    const out = {};
    const box = floodFill(sctx, area.w, area.h, px - area.x, py - area.y, hexToRgba(color), undefined, null, walls, seep, out);
    releaseCanvas(seen);
    if (box) {
      // the filled pixels, painted onto this layer
      const rctx = region.getContext('2d');
      const img = rctx.getImageData(0, 0, area.w, area.h);
      const [fr, fg, fb, fa] = hexToRgba(color);
      const f = out.filled;
      for (let i = 0, p = 0; i < f.length; i++, p += 4) {
        if (!f[i]) continue;
        img.data[p] = fr;
        img.data[p + 1] = fg;
        img.data[p + 2] = fb;
        img.data[p + 3] = fa;
      }
      rctx.putImageData(img, 0, 0);
    }
    if (box) {
      const changed = { x: area.x + box.minX, y: area.y + box.minY, w: box.maxX - box.minX + 1, h: box.maxY - box.minY + 1 };
      history.touch(changed);
      frame.writeRegion(changed, region, box.minX, box.minY);
      history.commit();
      layersPanel.refreshThumbnail(layer);
      timeline.refreshThumbnail(layer, layer.currentFrameIndex);
      updateHistoryButtons();
    } else {
      history.cancelPending();
    }
    releaseCanvas(region);
  }

  function beginNav() {
    if (mode === 'draw') abortDraw();
    if (mode === 'fillPending') {
      fillPointerId = null;
      fillDownPoint = null;
    }
    if (mode === 'lasso') abortLasso();
    if (mode === 'moveSel') abortMoveSelection();
    if (mode === 'bend') bendPointerId = null; // the bend so far stays
    // a second finger while placing points: it was a zoom, not a tap
    if (mode === 'waypoint') wpPointerId = null;
    if (mode === 'poly') abortPolyPoint();
    if (mode === 'objMove') abortObjectGesture();
    if (mode === 'objDraw') abortObjectDraw();
    if (mode === 'warp') warpGrab = null; // the frame stays as pulled so far
    mode = 'nav';
    dlog('nav-start', { scale: +view.scale.toFixed(3) });
    navIds = Array.from(activePointers.keys()).slice(0, 2);
    const [a, b] = navIds.map(id => activePointers.get(id));
    navPrev = { centroid: centroid(a, b), dist: distance(a, b), angle: angle(a, b) };
  }

  // moves the view by one step of a two-finger gesture: prev / cur are
  // the two fingers' client points before and after (pinch zooms, twist
  // turns, both moving pans — around the fingers)
  function navigateByStep(prev, cur) {
    const vc = viewportCenter();
    const c0 = centroid(prev[0], prev[1]);
    const c1 = centroid(cur[0], cur[1]);
    const d0 = distance(prev[0], prev[1]);
    if (d0 < 1) return;
    const anchorDoc = view.screenToDocument(c0.x, c0.y, vc);
    view.setScaleClamped(view.scale * (distance(cur[0], cur[1]) / d0));
    view.rotation += angle(cur[0], cur[1]) - angle(prev[0], prev[1]);
    view.reanchor(vc, anchorDoc, c1.x, c1.y);
    applyView();
  }

  let lastNavLog = 0;
  function updateNav() {
    if (navIds.length < 2) return;
    const [a, b] = navIds.map(id => activePointers.get(id));
    if (!a || !b) return;

    const curCentroid = centroid(a, b);
    const curDist = distance(a, b);
    const curAngle = angle(a, b);

    const scaleFactor = curDist / navPrev.dist;
    const deltaAngle = curAngle - navPrev.angle;
    const vc = viewportCenter();
    const anchorDoc = view.screenToDocument(navPrev.centroid.x, navPrev.centroid.y, vc);

    view.setScaleClamped(view.scale * scaleFactor);
    view.rotation += deltaAngle;
    view.reanchor(vc, anchorDoc, curCentroid.x, curCentroid.y);
    applyView();
    if (performance.now() - lastNavLog > 200) {
      lastNavLog = performance.now();
      dlog('nav', { scale: +view.scale.toFixed(3), rot: +view.rotation.toFixed(2), pan: [Math.round(view.panX), Math.round(view.panY)] });
    }

    navPrev = { centroid: curCentroid, dist: curDist, angle: curAngle };
  }

  // --- brush size preview ring ---
  // A circle the size the line will actually be on screen (brush size ×
  // the usual finger/mouse pressure × zoom). Shown in the middle of the
  // canvas area while the size slider moves, then fades; with a mouse it
  // also follows the cursor over the canvas, like a Photoshop brush cursor.
  // pressure the preview assumes: whatever the last stroke actually used
  // (devices differ — a finger may report 0.5 or 1), 0.5 until then
  let lastPressure = 0.5;
  const brushRing = document.createElement('div');
  brushRing.className = 'brush-ring';
  canvasWrap.appendChild(brushRing);
  let ringFadeTimer = null;
  let ringHover = null; // last mouse position over the canvas, client coords

  function placeBrushRing(clientX, clientY, pressure = lastPressure) {
    const rect = canvasWrap.getBoundingClientRect();
    const d = Math.max(3, size * pressure * view.scale);
    brushRing.style.width = `${d}px`;
    brushRing.style.height = `${d}px`;
    brushRing.style.left = `${clientX - rect.left}px`;
    brushRing.style.top = `${clientY - rect.top}px`;
    brushRing.classList.toggle('eraser', tool === 'eraser');
  }

  function flashBrushRing() {
    const rect = canvasWrap.getBoundingClientRect();
    placeBrushRing(rect.left + rect.width / 2, rect.top + rect.height / 2);
    brushRing.classList.add('show');
    clearTimeout(ringFadeTimer);
    ringFadeTimer = setTimeout(() => {
      if (ringHover) placeBrushRing(ringHover.x, ringHover.y);
      else brushRing.classList.remove('show');
    }, 1000);
  }

  function updateHoverRing() {
    const usable = ringHover && (tool === 'brush' || tool === 'eraser');
    if (usable) placeBrushRing(ringHover.x, ringHover.y);
    brushRing.classList.toggle('show', Boolean(usable));
  }

  // while a stroke is being drawn the ring rides along with the finger /
  // pen, sized by the actual pressure of that point
  function trackDrawRing(e) {
    clearTimeout(ringFadeTimer);
    lastPressure = docPointFromEvent(e).pressure;
    placeBrushRing(e.clientX, e.clientY, lastPressure);
    brushRing.classList.add('show');
  }

  canvasWrap.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    ringHover = { x: e.clientX, y: e.clientY };
    clearTimeout(ringFadeTimer);
    updateHoverRing();
  });
  canvasWrap.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse') return;
    ringHover = null;
    updateHoverRing();
  });

  function setTool(next) {
    if (tool === 'lasso' && next !== 'lasso') clearSelection();
    // leaving the line tool: the line placed so far is drawn, not lost
    if (tool === 'poly' && next !== 'poly') commitPoly();
    if (next !== 'poly') polyPoints = [];
    tool = next;
    updateHoverRing();
    // one button for brush and eraser. Its icon is what a tap switches TO:
    // the eraser while drawing, the pencil while erasing, and from fill /
    // lasso whichever of the two was used last.
    const switched = (tool === 'brush' || tool === 'eraser') && tool !== drawTool;
    if (tool === 'brush' || tool === 'eraser') drawTool = tool;
    const target = tool === 'brush' ? 'eraser' : tool === 'eraser' ? 'brush' : drawTool;
    setIcon(brushBtn, target === 'eraser' ? 'eraser' : 'pencil');
    brushBtn.title = target === 'eraser' ? 'Переключить на ластик' : 'Переключить на кисть';
    if (switched) setSize(toolSizes[drawTool]);
    fillBtn.classList.toggle('active', tool === 'fill');
    lassoBtn.classList.toggle('active', tool === 'lasso');
    guideBtn.classList.toggle('active', tool === 'guide' && !guideErase);
    guideBtn.classList.toggle('erase', tool === 'guide' && guideErase);
    guideBtn.title = tool === 'guide'
      ? (guideErase ? 'Стирание границ (нажмите — рисовать)' : 'Границы для заливки (нажмите — стирать их)')
      : 'Границы для заливки';
    updatePolyBar();
    updateObjectBar();
    drawSelectionOutline();
  }

  function stopPlayback() {
    if (!playTimer) return;
    clearInterval(playTimer);
    playTimer = null;
    layerManager.playing = false;
    setIcon(playBtn, 'play');
    // every layer was already kept in sync each tick, so nothing to resync here
    timeline.updatePlayhead();
    renderOnionSkin();
  }

  // --- initial UI state ---
  // timeline must be rendered first so the frame strip has its real height
  // before we measure canvasWrap for fitView() — otherwise the view is fit
  // to a too-tall canvas and drawing coordinates end up offset.
  timeline.render();
  fitView();
  updateHistoryButtons();
  updateSelectionBar();
  renderOnionSkin();

  // --- wiring ---
  layersToggleBtn.addEventListener('click', () => {
    setLayersPanelOpen(!layersPanelEl.classList.contains('open'));
  });

  layersBackdropEl.addEventListener('click', () => setLayersPanelOpen(false));

  addLayerBtn.addEventListener('click', () => {
    // right over the selected layer
    layerManager.addLayer(`Слой ${layerManager.layers.length + 1}`, { above: layerManager.activeLayer });
    layersPanel.render();
    timeline.render();
    scheduleSave();
  });

  bgButton.addEventListener('click', () => {
    openBackgroundDialog({ layerManager, onChange: () => scheduleSave() });
  });

  importVideoBtn.addEventListener('click', () => {
    videoFileInput.value = '';
    videoFileInput.click();
  });

  // video → a new JPEG-encoded layer under everything else, one frame per
  // sampled moment. Not undoable (same as adding a layer) — delete the
  // layer to get rid of it.
  async function importVideoFile(file) {
    if (!file) return;
    stopPlayback();
    if (floatingFragment) clearSelection();
    // the clip starts on the frame you're on
    const at = layerManager.playhead;

    let opened;
    try {
      opened = await openVideo(file);
    } catch (e) {
      alert(e.message);
      return;
    }
    try {
      const settings = await openVideoImportDialog(opened.duration);
      if (!settings) return;
      hideVideoImportDialog();

      // position / scale / rotate it over the canvas — one transform for the whole clip
      setLayersPanelOpen(false);
      const placement = await placeVideo({
        source: opened.video,
        docWidth,
        docHeight,
        start: settings.start,
        stage: layerStack,
        canvasWrap,
        appEl: document.getElementById('app'),
        toDoc: (x, y) => view.screenToDocument(x, y, viewportCenter()),
        navigate: navigateByStep,
      });
      if (!placement) return;
      // JPEG is far smaller but has no transparency — only usable when the
      // video leaves no part of the canvas uncovered
      const encoding = coversDocument(placement, docWidth, docHeight) ? 'jpeg' : 'png';

      const ref = layerManager.activeLayer ?? layerManager.layers[0];
      const progress = showVideoImportProgress();
      let frames;
      try {
        frames = await extractFrames(opened, {
          width: ref.pixelWidth,
          height: ref.pixelHeight,
          docWidth,
          placement,
          encoding,
          start: settings.start,
          end: settings.end,
          step: 1 / settings.fps,
          ticksPerFrame: settings.ticks,
          onProgress: progress.update,
          isCancelled: progress.isCancelled,
        });
      } finally {
        progress.close();
      }
      if (!frames?.length) return;

      const previousActive = layerManager.activeLayer;
      const layer = layerManager.addLayer('Видео', { encoding, atBottom: true });
      layer.replaceFrames(frames.map(f => new Frame(layer, f.duration, f.blob)));
      layer.start = at;
      layer.syncToTime(layerManager.playhead);
      if (settings.traceMode) {
        layer.opacity = 0.5;
        layer.applyVisualState();
      }
      // keep drawing where you were — on top of the video
      if (previousActive) layerManager.setActive(previousActive.id);

      layersPanel.render();
      timeline.render();
      renderOnionSkin();
      scheduleSave();
    } catch (e) {
      alert('Не удалось импортировать видео: ' + e.message);
    } finally {
      opened.close();
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Не удалось открыть картинку — формат не поддерживается?'));
      };
      img.src = url;
    });
  }

  // picture → a layer of its own, right over the selected one, shown from
  // the frame you're on to the end of the animation; placed with the same
  // screen as a video. Not undoable (same as adding a layer) — delete the layer.
  async function importImageFile(file) {
    stopPlayback();
    if (floatingFragment) clearSelection();
    const at = layerManager.playhead;
    let img;
    try {
      img = await loadImage(file);
    } catch (e) {
      alert(e.message);
      return;
    }
    setLayersPanelOpen(false);
    const placement = await placeVideo({
      source: img,
      docWidth,
      docHeight,
      initialFit: 'fit',
      stage: layerStack,
      canvasWrap,
      appEl: document.getElementById('app'),
      toDoc: (x, y) => view.screenToDocument(x, y, viewportCenter()),
      navigate: navigateByStep,
    });
    if (!placement) return;

    const until = layerManager.totalDuration;
    const layer = layerManager.addLayer('Картинка', { above: layerManager.activeLayer });
    layer.start = at;
    const frame = layer.frames[0];
    frame.duration = Math.max(1, until - at);
    frame.ensureResident();
    frame.drawWith(dirtyPx(layer, placedBounds(placement), 2), (ctx, ox, oy) => drawPlaced(ctx, img, placement, layer.dpr, ox, oy));
    layer.syncToTime(layerManager.playhead);
    layersPanel.render();
    timeline.render();
    scheduleSave();
  }

  videoFileInput.addEventListener('change', () => {
    const file = videoFileInput.files?.[0];
    if (file) importVideoFile(file);
  });

  importImageBtn.addEventListener('click', () => {
    imageFileInput.value = '';
    imageFileInput.click();
  });

  imageFileInput.addEventListener('change', () => {
    const file = imageFileInput.files?.[0];
    if (file) importImageFile(file);
  });

  fitViewBtn.addEventListener('click', fitView);

  homeBtn.addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await doSave();
    location.reload();
  });

  selectionBarEl.addEventListener('pointerdown', e => e.stopPropagation());
  document.getElementById('placeBar').addEventListener('pointerdown', e => e.stopPropagation());

  // tap while brush/eraser is on: switch between them; from fill or lasso:
  // back to whichever of the two was used last
  brushBtn.addEventListener('click', () => {
    if (tool === 'brush') setTool('eraser');
    else if (tool === 'eraser') setTool('brush');
    else setTool(drawTool);
  });
  fillBtn.addEventListener('click', () => setTool('fill'));
  // borders: first tap draws them, the next one switches to erasing them
  guideBtn.addEventListener('click', () => {
    if (tool === 'guide') guideErase = !guideErase;
    else guideErase = false;
    if (!guidesVisible) setGuidesVisible(true); // drawing borders you can't see makes no sense
    setTool('guide');
  });
  function setGuidesVisible(on) {
    guidesVisible = on;
    guidesToggleBtn.classList.toggle('active', on);
    guidesToggleBtn.title = on ? 'Скрыть границы для заливки' : 'Показать границы для заливки';
    display.invalidate();
  }
  guidesToggleBtn.addEventListener('click', () => setGuidesVisible(!guidesVisible));
  lassoBtn.addEventListener('click', () => setTool('lasso'));
  polyBtn.addEventListener('click', () => setTool('poly'));
  polyModeBtn.addEventListener('click', () => {
    polyRound = !polyRound;
    try {
      localStorage.setItem('artist-poly-mode', polyRound ? 'round' : 'corners');
    } catch {
      // not remembered — still applies now
    }
    updatePolyBar();
    drawSelectionOutline();
  });
  polyUndoBtn.addEventListener('click', () => {
    polyPoints.pop();
    updatePolyBar();
    drawSelectionOutline();
  });
  polyCancelBtn.addEventListener('click', () => {
    polyPoints = [];
    updatePolyBar();
    drawSelectionOutline();
  });
  polyDoneBtn.addEventListener('click', () => commitPoly());
  polyBarEl.addEventListener('pointerdown', e => e.stopPropagation());
  colorPicker.addEventListener('input', e => {
    color = e.target.value;
    if (polyPoints.length) drawSelectionOutline(); // the line being placed shows it
  });
  function setSize(next) {
    size = Math.max(Number(sizeSlider.min), Math.min(Number(sizeSlider.max), next));
    toolSizes[drawTool] = size;
    sizeSlider.value = String(size);
    sizeLabel.textContent = String(size);
    sizeDownBtn.disabled = size <= Number(sizeSlider.min);
    sizeUpBtn.disabled = size >= Number(sizeSlider.max);
    flashBrushRing();
    if (polyPoints.length) drawSelectionOutline();
  }
  sizeSlider.addEventListener('input', e => setSize(Number(e.target.value)));
  sizeDownBtn.addEventListener('click', () => setSize(size - 1));
  sizeUpBtn.addEventListener('click', () => setSize(size + 1));

  playBtn.addEventListener('click', () => {
    if (playTimer) {
      stopPlayback();
      return;
    }
    setIcon(playBtn, 'pause');
    layerManager.playing = true;
    editMotionBtn.style.display = 'none';
    display.invalidate(); // no onion skin while playing

    playTimer = setInterval(() => {
      // loops at the animation's end (frames past it don't play)
      const next = layerManager.playhead + 1;
      layerManager.setPlayhead(next >= layerManager.totalDuration ? 0 : next);
      timeline.updatePlayhead();
    }, 1000 / 12);
    updateObjectBar(); // (no object guides while playing)
  });

  // layers' colors and onion skin: one or the other (both at once are hard
  // to tell apart) — turning one on turns the other off
  function setLayerColors(on) {
    layerManager.tintsShown = on;
    layerColorsBtn.classList.toggle('active', on);
    layerColorsBtn.title = on ? 'Цвета слоёв включены (нажмите — выключить)' : 'Цвета слоёв выключены (нажмите — включить)';
    try {
      localStorage.setItem('artist-layer-colors', on ? 'on' : 'off');
    } catch {
      // not remembered — still applies now
    }
    if (on && onionEnabled) setOnion(false);
    display.invalidate();
    drawSelectionOutline();
    timeline.render();
    for (const layer of layerManager.layers) layersPanel.refreshThumbnail(layer);
  }
  function setOnion(on) {
    onionEnabled = on;
    onionBtn.classList.toggle('active', on);
    if (on && layerManager.tintsShown) setLayerColors(false);
    renderOnionSkin();
  }
  let colorsOn = true;
  try {
    colorsOn = localStorage.getItem('artist-layer-colors') !== 'off';
  } catch {
    // default
  }
  setLayerColors(colorsOn);
  layerColorsBtn.addEventListener('click', () => setLayerColors(!layerManager.tintsShown));

  onionBtn.addEventListener('click', () => {
    setOnion(!onionEnabled);
  });

  // ---- frames keep their place in time: deleting one leaves an empty
  // stretch (a gap frame) and the others stay put; one can be moved to any
  // tick ----

  const isGap = f => Boolean(f?.gap && f.isBlank);

  // the layer's frames where they are in time — [{ t, frame }], gaps left out
  function placedFrames(layer) {
    const out = [];
    let t = layer.start;
    for (const f of layer.frames) {
      if (!isGap(f)) out.push({ t, frame: f });
      t += f.duration;
    }
    return out;
  }

  // [{ t, frame }] (not overlapping) -> { start, frames }: gaps between,
  // none before the first or after the last. No frames left: one blank one
  // where `fallback` is
  function layoutOf(layer, items, fallback) {
    items = [...items].sort((a, b) => a.t - b.t);
    if (!items.length) return { start: fallback, frames: [new Frame(layer, 1)] };
    const frames = [];
    let t = items[0].t;
    for (const it of items) {
      if (it.t > t) {
        const g = new Frame(layer, it.t - t);
        g.gap = true;
        frames.push(g);
      }
      frames.push(it.frame);
      t = it.t + it.frame.duration;
    }
    return { start: items[0].t, frames };
  }

  // the layer laid out anew — one undo step; the playhead's frame selected
  function applyLayout(layer, layout) {
    history.beginBatch(layer, 0);
    history.recordLayout({ start: layer.start, frames: [...layer.frames] }, layout);
    layer.setLayout(layout.start, [...layout.frames]);
    history.commitBatch();
    layer.syncToTime(layerManager.playhead);
  }

  // is [t, t + d) free of frames (but `except`)
  function freeAt(items, t, d, except = null) {
    return items.every(it => it.frame === except || it.t + it.frame.duration <= t || it.t >= t + d);
  }

  // Drawing where the active layer has no frame (an empty stretch, before
  // its first frame or past its last): it gets a frame of one tick right
  // here, so the drawing shows exactly at this moment. One undo step
  // (separate from the drawing itself).
  function ensureFrameHere(layer) {
    if (!layer || layer.kind === 'object') return false;
    if (!layer.ended && !isGap(layer.currentFrame)) return false;
    const t = layerManager.playhead;
    applyLayout(layer, layoutOf(layer, [...placedFrames(layer), { t, frame: new Frame(layer, 1) }], t));
    timeline.render();
    updateHistoryButtons();
    return true;
  }

  // a frame dragged to start at tick t: there if that's free; onto a frame
  // as long as itself starting there, the two swap places; otherwise it
  // stays where it was
  function moveFrameTo(layer, frameIndex, t) {
    const frame = layer.frames[frameIndex];
    const items = placedFrames(layer);
    const me = items.find(it => it.frame === frame);
    if (!me) return;
    const d = frame.duration;
    if (freeAt(items, t, d, frame)) {
      me.t = t;
    } else {
      const other = items.find(it => it.frame !== frame && it.t === t && it.frame.duration === d);
      if (!other) {
        timeline.render();
        return;
      }
      other.t = me.t;
      me.t = t;
    }
    applyLayout(layer, layoutOf(layer, items, t));
    layerManager.setActive(layer.id);
    layerManager.setPlayhead(t);
    layersPanel.render();
    timeline.render();
    renderOnionSkin();
    updateHistoryButtons();
  }

  // inserts a new blank frame at insertAt and selects it — one undo step
  // (a copy of a frame: pull it longer by its handle)
  function addFrameAt(layer, insertAt) {
    const frame = new Frame(layer, 1);
    history.beginBatch(layer, insertAt);
    layer.insertFrameObject(insertAt, frame);
    history.recordInsert(insertAt, frame);
    layer.setActiveFrame(insertAt);
    history.commitBatch();
  }

  // +: a blank frame. On an empty stretch: right here. On a frame: right after it — in the
  // empty tick there, or (no room) pushing the frames after it along.
  addFrameBtn.addEventListener('click', () => {
    stopPlayback();
    const layer = layerManager.activeLayer;
    if (!layer || layer.kind === 'object') return;
    if (layer.ended || isGap(layer.currentFrame)) {
      ensureFrameHere(layer);
    } else {
      const cur = layer.currentFrame;
      const items = placedFrames(layer);
      const t = items.find(it => it.frame === cur).t + cur.duration;
      if (freeAt(items, t, 1)) {
        const frame = new Frame(layer, 1);
        applyLayout(layer, layoutOf(layer, [...items, { t, frame }], t));
      } else {
        addFrameAt(layer, layer.currentFrameIndex + 1);
      }
      layerManager.setPlayhead(t);
    }
    layersPanel.render();
    timeline.render();
    renderOnionSkin();
    updateHistoryButtons();
  });

  // the selected frame goes; an empty stretch stays in its place — the
  // frames after it don't move
  removeFrameBtn.addEventListener('click', () => {
    stopPlayback();
    const layer = layerManager.activeLayer;
    if (!layer || layer.kind === 'object' || layer.ended || isGap(layer.currentFrame)) return;
    const frame = layer.currentFrame;
    const items = placedFrames(layer);
    const t = items.find(it => it.frame === frame).t;
    applyLayout(layer, layoutOf(layer, items.filter(it => it.frame !== frame), t));
    layersPanel.refreshThumbnail(layer);
    timeline.render();
    renderOnionSkin();
    updateHistoryButtons();
  });

  // ‹‹ / ››: the selected frame and every frame after it move one tick
  // left / right (on an empty stretch: the frames after it). Left only
  // into an empty tick — never over a frame or before the start of time
  function shiftFrames(dir) {
    stopPlayback();
    const layer = layerManager.activeLayer;
    if (!layer || layer.kind === 'object') return;
    const items = placedFrames(layer);
    const onFrame = !layer.ended && !isGap(layer.currentFrame);
    const pivot = onFrame
      ? items.find(it => it.frame === layer.currentFrame).t
      : items.find(it => it.t >= layerManager.playhead)?.t;
    if (pivot == null) return;
    if (dir < 0 && (pivot < 1 || !freeAt(items.filter(it => it.t < pivot), pivot - 1, 1))) return;
    for (const it of items) if (it.t >= pivot) it.t += dir;
    applyLayout(layer, layoutOf(layer, items, pivot + dir));
    if (onFrame) layerManager.setPlayhead(pivot + dir);
    else layer.syncToTime(layerManager.playhead);
    layersPanel.render();
    timeline.render();
    renderOnionSkin();
    updateHistoryButtons();
  }
  shiftLeftBtn.addEventListener('click', () => shiftFrames(-1));
  shiftRightBtn.addEventListener('click', () => shiftFrames(1));

  // hide the frame strip from the strip itself; a small button in the
  // corner brings it back
  // how many tracks (layers) the timeline shows: 3, 1 (the selected
  // layer's) or none — the button goes round them. It lies over the canvas,
  // so the picture stays where it is. Remembered.
  const TRACK_MODES = [3, 1, 0];
  let tracksShown = 3;
  try {
    const saved = Number(localStorage.getItem('artist-tracks-shown'));
    if (TRACK_MODES.includes(saved) && localStorage.getItem('artist-tracks-shown') !== null) tracksShown = saved;
  } catch {
    // default
  }
  function setTracksShown(n) {
    tracksShown = n;
    timelineBarEl.style.setProperty('--tracks', String(Math.max(1, n)));
    timelineBarEl.classList.toggle('no-tracks', n === 0);
    const next = TRACK_MODES[(TRACK_MODES.indexOf(n) + 1) % TRACK_MODES.length];
    setIcon(timelineToggleBtn, next > n ? 'chevron-up' : 'chevron-down');
    timelineToggleBtn.title = `Слоёв на дорожке: ${n} (нажмите — ${next})`;
    try {
      localStorage.setItem('artist-tracks-shown', String(n));
    } catch {
      // not remembered — still applies now
    }
    syncTimelineHeight();
    timeline.revealActive();
  }
  setTracksShown(tracksShown);
  timelineToggleBtn.addEventListener('click', () => setTracksShown(TRACK_MODES[(TRACK_MODES.indexOf(tracksShown) + 1) % TRACK_MODES.length]));
  // (left from when the strip could be hidden whole)
  timelineShowBtn.addEventListener('click', () => setTracksShown(3));

  // undo/redo may have to wait for a frame to decode — don't let a second
  // tap interleave with one still in flight
  let historyBusy = false;
  async function runHistory(btn, action) {
    if (historyBusy) return;
    historyBusy = true;
    flashBtn(btn);
    try {
      await action();
    } catch (e) {
      console.error(e);
    } finally {
      historyBusy = false;
    }
  }

  undoBtn.addEventListener('click', () => runHistory(undoBtn, async () => {
    await history.undo(layerManager);
    const layer = layerManager.activeLayer;
    if (layer) layersPanel.refreshThumbnail(layer);
    timeline.render();
    renderOnionSkin();
    updateHistoryButtons();
  }));

  redoBtn.addEventListener('click', () => runHistory(redoBtn, async () => {
    await history.redo(layerManager);
    const layer = layerManager.activeLayer;
    if (layer) layersPanel.refreshThumbnail(layer);
    timeline.render();
    renderOnionSkin();
    updateHistoryButtons();
  }));

  clearBtn.addEventListener('click', () => {
    const layer = layerManager.activeLayer;
    // past its last frame there's nothing on screen to clear
    if (!layer || layer.ended || layer.kind === 'object' || !history.begin(layer, layer.currentFrameIndex)) return;
    history.touchAll();
    layer.clear();
    history.commit();
    layersPanel.refreshThumbnail(layer);
    timeline.refreshThumbnail(layer, layer.currentFrameIndex);
    updateHistoryButtons();
  });

  // mirror the lifted piece, as it looks on screen (left-right or
  // top-bottom about its middle) — it stays where it is, turned the other way
  function flipFloating(horizontal) {
    if (!floatingFragment) return;
    const src = floatingFragment.canvas;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d');
    if (horizontal) ctx.setTransform(-1, 0, 0, 1, c.width, 0);
    else ctx.setTransform(1, 0, 0, -1, 0, c.height);
    ctx.drawImage(src, 0, 0);
    // a new canvas: the clipboard may still hold the old one. The mask
    // (where the piece was cut from) stays as it is
    floatingFragment = { ...floatingFragment, canvas: c };
    // a mirror on screen of a turned piece = the piece mirrored, turned
    // the other way
    floatingRotation = -floatingRotation;
    const center = fragmentCenterDoc();
    if (selection?.outline) selection.outline = selection.outline.map(path => path.map(p => (horizontal
      ? { x: 2 * center.x - p.x, y: p.y }
      : { x: p.x, y: 2 * center.y - p.y })));
    redrawOverlay();
  }
  // ---- transform: a frame round the piece, its corners pulled anywhere
  // (perspective), its sides' middles move a whole side (stretch / skew).
  // ✓ redraws the piece in its new shape, and it floats on as before ----

  // the piece's corners as it's shown now (moved / scaled / turned)
  function placementQuad() {
    const dpr = floatingLayer.dpr || 1;
    const center = fragmentCenterDoc();
    const o = currentOffset();
    const s = currentScale();
    const r = currentRotation();
    const cos = Math.cos(r), sin = Math.sin(r);
    const hw = floatingFragment.w / dpr / 2 * s, hh = floatingFragment.h / dpr / 2 * s;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({
      x: center.x + o.x + sx * hw * cos - sy * hh * sin,
      y: center.y + o.y + sx * hw * sin + sy * hh * cos,
    }));
  }

  function enterWarp() {
    if (!floatingFragment || motionEdit || warp) return;
    stopTweenPlay();
    tweenEdit = null;
    warp = placementQuad();
    updateSelectionBar();
    drawSelectionOutline();
  }

  function endWarp() {
    warp = null;
    warpGrab = null;
    warpTwo = null;
    if (mode === 'warp' || mode === 'warpTwo') mode = activePointers.size ? 'picked' : 'idle';
    updateSelectionBar();
    drawSelectionOutline();
  }

  // the piece redrawn onto the frame's shape: a new picture, unturned and
  // unscaled, where the frame is — its outline bent along with it
  function applyWarp() {
    const quad = warp;
    const dpr = floatingLayer.dpr || 1;
    const frag = floatingFragment;
    const out = warpCanvas(frag.canvas, quad.map(p => ({ x: p.x * dpr, y: p.y * dpr })));
    if (selection?.outline) {
      const m = squareToQuad(quad);
      const left = frag.x / dpr, top = frag.y / dpr, w = frag.w / dpr, h = frag.h / dpr;
      selection.outline = selection.outline.map(path => path.map(p => m.map((p.x - left) / w, (p.y - top) / h)));
    }
    floatingFragment = { canvas: out.canvas, x: out.x, y: out.y, w: out.canvas.width, h: out.canvas.height };
    floatingOffset = { x: 0, y: 0 };
    floatingScale = 1;
    floatingRotation = 0;
    dragDelta = { x: 0, y: 0 };
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
    endWarp();
  }

  function insideQuad(quad, p) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = quad[i], b = quad[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  const edgeMid = (quad, i) => ({ x: (quad[i].x + quad[(i + 1) % 4].x) / 2, y: (quad[i].y + quad[(i + 1) % 4].y) / 2 });

  // a corner, else a side's middle, within reach of the finger; else the
  // inside moves the whole frame; else nothing
  function beginWarpGrab(e, docPt) {
    const reach = 26 / view.scale;
    const near = p => Math.hypot(p.x - docPt.x, p.y - docPt.y);
    let kind = null, index = -1, best = reach;
    warp.forEach((p, i) => {
      if (near(p) <= best) { kind = 'corner'; index = i; best = near(p); }
    });
    if (!kind) {
      for (let i = 0; i < 4; i++) {
        const d = near(edgeMid(warp, i));
        if (d <= best) { kind = 'edge'; index = i; best = d; }
      }
    }
    if (!kind && insideQuad(warp, docPt)) kind = 'move';
    if (!kind) return; // beside the frame: nothing (✓ / ✕ finish)
    mode = 'warp';
    warpGrab = { id: e.pointerId, kind, index, startDoc: docPt, startQuad: warp.map(p => ({ ...p })) };
  }

  // at most once a screen refresh — a phone sends touch moves faster
  let warpDrawPending = 0;
  function drawWarpSoon() {
    if (warpDrawPending) return;
    warpDrawPending = requestAnimationFrame(() => {
      warpDrawPending = 0;
      if (warp) drawSelectionOutline();
    });
  }

  function moveWarpGrab(docPt) {
    const g = warpGrab;
    const dx = docPt.x - g.startDoc.x, dy = docPt.y - g.startDoc.y;
    const moved = i => (g.kind === 'move' || (g.kind === 'corner' && i === g.index) ||
      (g.kind === 'edge' && (i === g.index || i === (g.index + 1) % 4)));
    warp = g.startQuad.map((p, i) => (moved(i) ? { x: p.x + dx, y: p.y + dy } : { ...p }));
    drawWarpSoon();
  }

  // two fingers on the frame: move / turn / scale it whole, its shape kept
  function beginWarpTwo(ids, aDoc, bDoc) {
    if (mode === 'warp') warpGrab = null;
    mode = 'warpTwo';
    warpTwo = { ids, a: aDoc, b: bDoc, startQuad: warp.map(p => ({ ...p })) };
  }

  function moveWarpTwo() {
    const [pa, pb] = warpTwo.ids.map(id => activePointers.get(id));
    if (!pa || !pb) return;
    const a = docPointFromEvent({ clientX: pa.x, clientY: pa.y });
    const b = docPointFromEvent({ clientX: pb.x, clientY: pb.y });
    const { a: a0, b: b0, startQuad } = warpTwo;
    const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
    const s = Math.min(10, Math.max(0.1, Math.hypot(b.x - a.x, b.y - a.y) / d0));
    const r = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
    const c0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
    const c1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const cos = Math.cos(r) * s, sin = Math.sin(r) * s;
    warp = startQuad.map(p => {
      const dx = p.x - c0.x, dy = p.y - c0.y;
      return { x: c1.x + dx * cos - dy * sin, y: c1.y + dx * sin + dy * cos };
    });
    drawWarpSoon();
  }

  // the piece on the frame's shape, the frame, its eight handles
  function drawWarpFrame() {
    overlay.drawFragmentWarped(floatingFragment.canvas, warp, floatingLayer.opacity);
    overlay.strokeDashedPath(warp, true);
    for (const p of warp) overlay.dot(p.x, p.y, 9, '#fff', '#2f6fed');
    for (let i = 0; i < 4; i++) {
      const m = edgeMid(warp, i);
      overlay.dot(m.x, m.y, 6.5, '#2f6fed', '#fff');
    }
  }

  warpSelBtn.addEventListener('click', enterWarp);

  flipHSelBtn.addEventListener('click', () => flipFloating(true));
  flipVSelBtn.addEventListener('click', () => flipFloating(false));

  copySelBtn.addEventListener('click', () => {
    if (!floatingFragment) return;
    const dpr = floatingLayer.dpr || 1;
    const o = currentOffset();
    clipboard = {
      canvas: floatingFragment.canvas,
      x: floatingFragment.x + o.x * dpr,
      y: floatingFragment.y + o.y * dpr,
      w: floatingFragment.w,
      h: floatingFragment.h,
    };
    updateSelectionBar();
  });

  cutSelBtn.addEventListener('click', () => {
    if (!floatingFragment) return;
    const layer = floatingLayer;
    const dpr = layer.dpr || 1;
    const o = currentOffset();
    clipboard = {
      canvas: floatingFragment.canvas,
      x: floatingFragment.x + o.x * dpr,
      y: floatingFragment.y + o.y * dpr,
      w: floatingFragment.w,
      h: floatingFragment.h,
    };

    history.commit(); // the hole was already cut at lift time; this just finalizes it
    layersPanel.refreshThumbnail(layer);
    timeline.refreshThumbnail(layer, layer.frames.indexOf(floatingFrame));

    unpinFloatingFrame();
    floatingFragment = null;
    floatingLayer = null;
    floatingOffset = { x: 0, y: 0 };
    floatingScale = 1;
    floatingRotation = 0;
    dragDelta = { x: 0, y: 0 };
    selection = null;
    overlay.clear();
    updateSelectionBar();
    updateHistoryButtons();
  });

  // origin: where ctx's canvas sits — { x, y } in layer pixels (a frame)
  function drawFragmentOnContext(ctx, fragment, center, transform, dpr, origin) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.translate((center.x + transform.offset.x) * dpr - origin.x, (center.y + transform.offset.y) * dpr - origin.y);
    ctx.rotate(transform.rotation);
    ctx.scale(transform.scale, transform.scale);
    ctx.drawImage(fragment.canvas, -fragment.w / 2, -fragment.h / 2);
    ctx.restore();
  }

  // the area (layer pixels) the fragment covers at each of the given
  // placements ({ center, offset, scale } — any rotation: the bound is the
  // fragment's circumscribed circle)
  function fragmentRectPx(layer, placements, fragment = floatingFragment) {
    const dpr = layer.dpr || 1;
    const half = Math.hypot(fragment.w, fragment.h) / dpr / 2 + 2;
    let b = null;
    for (const { center, offset, scale } of placements) {
      const cx = center.x + offset.x;
      const cy = center.y + offset.y;
      const r = half * scale;
      b = b
        ? { x0: Math.min(b.x0, cx - r), y0: Math.min(b.y0, cy - r), x1: Math.max(b.x1, cx + r), y1: Math.max(b.y1, cy + r) }
        : { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
    }
    return dirtyPx(layer, b, 0);
  }

  // the in-between frames of a movement: for each placement after the
  // first, the base frame without the piece (template: "tx,ty" -> { tx, ty,
  // blob, canvas? }) with the piece drawn at that placement. Only the tiles
  // the piece lands on are drawn, one at a time, and encoded right away —
  // so a long one never holds its frames decoded.
  // from: the first placement made into a frame (1: the first one is the
  // base frame itself)
  async function motionFrames(layer, fragment, center, placements, template, from = 1) {
    const dpr = layer.dpr || 1;
    const scratch = newTileCanvas();
    const sctx = scratch.getContext('2d');
    const decoded = []; // template tiles decoded here, released after
    const frames = [];
    try {
      for (let i = from; i < placements.length; i++) {
        const interp = placements[i];
        const tiles = new Map();
        for (const [k, tt] of template) if (tt.blob) tiles.set(k, { x: tt.tx, y: tt.ty, blob: tt.blob });
        const { tx0, ty0, tx1, ty1 } = tileRange(fragmentRectPx(layer, [{ center, ...interp }], fragment));
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            const k = `${tx},${ty}`;
            sctx.clearRect(0, 0, TILE, TILE);
            const base = template.get(k);
            if (base && !base.canvas && base.blob) {
              const bm = await createImageBitmap(base.blob);
              base.canvas = newTileCanvas();
              base.canvas.getContext('2d').drawImage(bm, 0, 0);
              bm.close?.();
              decoded.push(base);
            }
            if (base?.canvas) sctx.drawImage(base.canvas, 0, 0);
            drawFragmentOnContext(sctx, fragment, center, interp, dpr, { x: tx * TILE, y: ty * TILE });
            if (isTransparent(scratch)) tiles.delete(k);
            else tiles.set(k, { x: tx, y: ty, blob: await encodeCanvas(scratch, layer.encoding) });
          }
        }
        frames.push(Frame.fromTiles(layer, 1, [...tiles.values()]));
        updateExportProgress(i, placements.length - 1, 'Создание кадров…');
      }
    } finally {
      releaseCanvas(scratch);
      for (const t of decoded) {
        releaseCanvas(t.canvas);
        t.canvas = null;
      }
    }
    return frames;
  }

  // the placements of a movement's frames (from the floating piece's state)
  function motionPlacements(n, easingId, opts) {
    const ease = EASING_FNS[easingId] || EASING_FNS.linear;
    const placements = [];
    for (let i = 0; i < n; i++) placements.push(tweenAt(ease(i / Math.max(1, n - 1)), opts));
    return placements;
  }

  // the frames made from a movement remember it (frame.motion: shared by
  // all of them) — so it can be opened again and changed: its points,
  // ease, number of frames, where it ends. motion: { base (the frame it
  // starts on), piece: { canvas, blob, x, y, w, h } (layer pixels),
  // template (the base frame without the piece, "tx,ty" -> { tx, ty,
  // blob }), end: { offset, scale, rotation }, easing, count, bend,
  // waypoints, path }. frame.motionVersion: its version when made — drawn
  // on since, it's no longer exactly what the movement makes
  function markMotionFrames(frames, motion) {
    for (const f of frames) {
      f.motion = motion;
      f.motionVersion = f.version;
    }
  }

  // the movement as frames on a layer of its own, right over the piece's
  // layer: one frame per placement, from the tick the piece's frame starts
  // at (a blank frame before that). The piece leaves its frame (a pasted
  // one: nothing to leave) — that cut is undoable; the new layer, like any
  // added layer, isn't.
  // opts: the trajectory — { bend } for an arc, { path, waypoints } for a drawn one
  async function generateTween(n, easingId, opts = {}) {
    const layer = floatingLayer;
    const baseFrame = floatingFrame;
    const baseIndex = layer.frames.indexOf(baseFrame);
    let startTick = layer.start;
    for (let i = 0; i < baseIndex; i++) startTick += layer.frameDurationAt(i);
    const center = fragmentCenterDoc();
    const fragment = floatingFragment;
    // every placement along the (possibly bent) path, worked out now while
    // the piece's end transform is still at hand
    const placements = motionPlacements(n, easingId, opts);
    const end = { offset: currentOffset(), scale: currentScale(), rotation: currentRotation() };

    if (floatingPasted) history.cancelPending();
    else history.commit();
    unpinFloatingFrame();
    floatingFragment = null;
    floatingLayer = null;
    floatingOffset = { x: 0, y: 0 };
    floatingScale = 1;
    floatingRotation = 0;
    dragDelta = { x: 0, y: 0 };
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
    selection = null;
    overlay.clear();
    updateSelectionBar();
    layersPanel.refreshThumbnail(layer);

    const ml = layerManager.addLayer('Движение', { above: layer });
    showExportProgress('Создание кадров…');
    try {
      const frames = await motionFrames(ml, fragment, center, placements, new Map(), 0);
      const motion = {
        base: null,
        withStart: true, // its frames start with the piece at its start
        piece: { canvas: fragment.canvas, blob: await encodeCanvas(fragment.canvas, 'png'), x: fragment.x, y: fragment.y, w: fragment.w, h: fragment.h },
        template: new Map(),
        end,
        easing: easingId,
        count: n,
        bend: opts.bend ?? null,
        waypoints: opts.waypoints ?? null,
        path: opts.path ?? null,
      };
      markMotionFrames(frames, motion);
      // the layer starts where the movement does — nothing before it
      ml.start = startTick;
      ml.replaceFrames(frames);
      ml.syncToTime(layerManager.playhead);
    } catch (e) {
      alert('Не удалось создать кадры: ' + e.message);
    } finally {
      hideExportDialog();
    }

    layersPanel.render();
    timeline.render();
    renderOnionSkin();
    updateHistoryButtons();
  }

  // ---- a movement opened again: its piece floats at its end, with the
  // same set-up as when it was made; ✓ makes its frames anew ----

  // the movement the selected frame is part of (or starts), if it can
  // still be changed (its first frame is still there)
  function motionHere() {
    const layer = layerManager.activeLayer;
    if (!layer || layer.ended || layer.kind === 'object') return null;
    const f = layer.currentFrame;
    if (f.motion && (f.motion.withStart || layer.frames.includes(f.motion.base))) return f.motion;
    return layer.frames.find(g => g.motion?.base === f)?.motion ?? null;
  }

  function updateMotionBtn() {
    const m = !floatingFragment && !selection && !playTimer ? motionHere() : null;
    editMotionBtn.style.display = m ? '' : 'none';
    // a movement on a layer of its own, its frame here drawn on since
    const f = layerManager.activeLayer?.currentFrame;
    regenMotionBtn.style.display = m?.withStart && f?.motion === m && f.version !== f.motionVersion ? '' : 'none';
  }

  // the movement made anew with the piece as it looks on the selected
  // frame (redrawn there): that frame's picture, turned back to how the
  // piece sat at the start, becomes the piece — same path, ease, frames
  async function regenerateWithNewLook() {
    const layer = layerManager.activeLayer;
    const frame = layer?.currentFrame;
    const m = frame?.motion;
    if (!m?.withStart) return;
    const ordered = layer.frames.filter(f => f.motion === m);
    const step = ordered.indexOf(frame);
    if (!(await frame.load(true).then(() => true, () => false))) return;
    const bx = frame.bounds();
    if (!bx) {
      alert('На этом кадре ничего нет');
      return;
    }
    // (read now, while that frame is surely decoded)
    const b = bx;
    const region = frame.readRegion(b);
    await editMotion(m); // the movement's set-up, as when it's changed
    const { bend, path, waypoints } = tweenEdit;
    const P = motionPlacements(m.count, m.easing, { bend, path, waypoints })[step];
    const C = fragmentCenterDoc();
    const dpr = layer.dpr || 1;
    // the frame's pixels -> the piece's own, centred on where it sat there
    const cx = (C.x + P.offset.x) * dpr;
    const cy = (C.y + P.offset.y) * dpr;
    const cos = Math.cos(-P.rotation);
    const sin = Math.sin(-P.rotation);
    const local = ([x, y]) => ({ x: ((x - cx) * cos - (y - cy) * sin) / P.scale, y: ((x - cx) * sin + (y - cy) * cos) / P.scale });
    const cs = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(local);
    const x0 = Math.floor(Math.min(...cs.map(p => p.x)));
    const y0 = Math.floor(Math.min(...cs.map(p => p.y)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(Math.max(...cs.map(p => p.x))) - x0);
    c.height = Math.max(1, Math.ceil(Math.max(...cs.map(p => p.y))) - y0);
    const ctx = c.getContext('2d');
    ctx.translate(-x0, -y0);
    ctx.scale(1 / P.scale, 1 / P.scale);
    ctx.rotate(-P.rotation);
    ctx.translate(-cx, -cy);
    ctx.drawImage(region, b.x, b.y);
    releaseCanvas(region);
    // at the start (no turn, no scaling) its centre sits that much off the old one
    const lcx = x0 + c.width / 2;
    const lcy = y0 + c.height / 2;
    floatingFragment = { canvas: c, x: Math.round(C.x * dpr + lcx - c.width / 2), y: Math.round(C.y * dpr + lcy - c.height / 2), w: c.width, h: c.height };
    await regenerateMotion(m.count, m.easing, { bend, path, waypoints }, { newPiece: true, except: frame });
  }

  async function editMotion(m) {
    const layer = layerManager.activeLayer;
    stopPlayback();
    if (floatingFragment || selection) clearSelection();
    if (!m.piece.canvas) {
      const bm = await createImageBitmap(m.piece.blob);
      const c = document.createElement('canvas');
      c.width = bm.width;
      c.height = bm.height;
      c.getContext('2d').drawImage(bm, 0, 0);
      bm.close?.();
      m.piece.canvas = c;
    }
    // the frame it starts on: the one before its frames, or its first one
    const start = m.withStart ? layer.frames.find(f => f.motion === m) : m.base;
    selectFrame(layer, layer.frames.indexOf(start));
    setTool('lasso');
    const { x, y, w, h } = m.piece;
    floatingFragment = { canvas: m.piece.canvas, x, y, w, h };
    floatingLayer = layer;
    floatingPasted = false;
    pinFloatingFrame(start);
    floatingOffset = { ...m.end.offset };
    floatingScale = m.end.scale;
    floatingRotation = m.end.rotation;
    dragDelta = { x: 0, y: 0 };
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
    const dpr = layer.dpr || 1;
    const rect = [{ x: x / dpr, y: y / dpr }, { x: (x + w) / dpr, y: y / dpr }, { x: (x + w) / dpr, y: (y + h) / dpr }, { x: x / dpr, y: (y + h) / dpr }];
    selection = { regions: [{ mode: 'add', path: rect }], outline: [rect] };
    tweenEdit = {
      frames: m.count, easing: m.easing, bend: m.bend ? { ...m.bend } : { x: 0, y: 0 }, preview: null,
      path: m.path, waypoints: m.waypoints, editingPath: null,
    };
    motionEdit = m;
    updateSelectionBar();
    updateHistoryButtons();
    drawSelectionOutline();
  }

  // leaves the movement as it was (nothing was changed on any frame)
  function exitMotionEdit() {
    stopTweenPlay();
    tweenEdit = null;
    motionEdit = null;
    unpinFloatingFrame();
    floatingFragment = null;
    floatingLayer = null;
    floatingOffset = { x: 0, y: 0 };
    floatingScale = 1;
    floatingRotation = 0;
    dragDelta = { x: 0, y: 0 };
    liveOffset = { x: 0, y: 0 };
    liveScale = 1;
    liveRotation = 0;
    selection = null;
    lassoMode = 'add';
    overlay.clear();
    updateSelectionBar();
    updateHistoryButtons();
  }

  // the movement's frames made anew from the changed set-up — one undo step
  // newPiece: the floating piece is a new look for it; except: a frame
  // whose drawing on it doesn't need asking about (that's the new look)
  async function regenerateMotion(n, easingId, opts, { newPiece = false, except = null } = {}) {
    const m = motionEdit;
    const layer = floatingLayer;
    const old = layer.frames.filter(f => f.motion === m);
    if (old.some(f => f !== except && f.version !== f.motionVersion) &&
      !confirm('На кадрах этого движения потом рисовали — эти изменения пропадут. Пересоздать кадры?')) return;
    const center = fragmentCenterDoc();
    const fragment = floatingFragment;
    const placements = motionPlacements(n, easingId, opts);
    const motion = {
      ...m,
      piece: newPiece
        ? { canvas: fragment.canvas, blob: await encodeCanvas(fragment.canvas, 'png'), x: fragment.x, y: fragment.y, w: fragment.w, h: fragment.h }
        : m.piece,
      end: { offset: currentOffset(), scale: currentScale(), rotation: currentRotation() },
      easing: easingId,
      count: n,
      bend: opts.bend ?? null,
      waypoints: opts.waypoints ?? null,
      path: opts.path ?? null,
    };
    exitMotionEdit();
    showExportProgress('Создание кадров…');
    let frames;
    try {
      frames = await motionFrames(layer, fragment, center, placements, m.template, m.withStart ? 0 : 1);
    } catch (e) {
      hideExportDialog();
      alert('Не удалось создать кадры: ' + e.message);
      return;
    }
    hideExportDialog();
    // (a new movement object: undo brings the old frames back with the old one)
    markMotionFrames(frames, motion);
    // where its frames are: after its base frame, or where they start
    const at = m.withStart ? Math.min(...old.map(f => layer.frames.indexOf(f))) : layer.frames.indexOf(m.base) + 1;
    history.beginBatch(layer, at);
    // the new ones in first, then the old ones out (a layer never has no
    // frame — the last old one couldn't go otherwise)
    frames.forEach((frame, i) => {
      layer.insertFrameObject(at + i, frame);
      history.recordInsert(at + i, frame);
    });
    for (const f of [...old].sort((a, b) => layer.frames.indexOf(b) - layer.frames.indexOf(a))) {
      const idx = layer.frames.indexOf(f);
      history.recordRemove(idx, f);
      layer.removeFrame(idx);
    }
    history.commitBatch();
    selectFrame(layer, m.withStart ? at : at - 1);
    layersPanel.refreshThumbnail(layer);
    updateHistoryButtons();
  }

  // 🎬: tween set-up — the piece stays movable (that's the end position),
  // with its start, the path and the in-between frames shown
  tweenBtn.addEventListener('click', () => {
    if (!floatingFragment) return;
    tweenEdit = { frames: 8, easing: 'easeInOut', bend: { x: 0, y: 0 }, preview: null, path: null, waypoints: null, editingPath: null };
    updateSelectionBar();
    drawSelectionOutline();
  });
  tweenFewerBtn.addEventListener('click', () => {
    tweenEdit.frames = Math.max(2, tweenEdit.frames - 1);
    updateSelectionBar();
    drawSelectionOutline();
  });
  tweenMoreBtn.addEventListener('click', () => {
    tweenEdit.frames = Math.min(60, tweenEdit.frames + 1);
    updateSelectionBar();
    drawSelectionOutline();
  });
  tweenEaseBtn.addEventListener('click', () => {
    const i = EASINGS.findIndex(e => e.id === tweenEdit.easing);
    tweenEdit.easing = EASINGS[(i + 1) % EASINGS.length].id;
    updateSelectionBar();
    drawSelectionOutline();
  });
  // ▶: the piece runs along the path frame by frame, at the playback
  // speed, over and over until tapped again
  function stopTweenPlay() {
    clearInterval(tweenPlayTimer);
    tweenPlayTimer = null;
    setIcon(tweenPlayBtn, 'play');
    if (tweenEdit) tweenEdit.preview = null;
  }
  tweenPlayBtn.addEventListener('click', () => {
    if (tweenPlayTimer) {
      stopTweenPlay();
      drawSelectionOutline();
      return;
    }
    setIcon(tweenPlayBtn, 'pause');
    let i = 0;
    const step = () => {
      if (!tweenEdit || !floatingFragment) {
        stopTweenPlay();
        return;
      }
      const n = tweenEdit.frames;
      tweenEdit.preview = (i % n) / (n - 1);
      i++;
      drawSelectionOutline();
    };
    step();
    tweenPlayTimer = setInterval(step, 1000 / 12);
  });
  // path through points: place / move points, then Готово
  tweenPathBtn.addEventListener('click', startPathEdit);
  pathUndoBtn.addEventListener('click', () => {
    const pts = tweenEdit.editingPath.points;
    if (pts.length > 1) pts.pop();
    updateSelectionBar();
    drawSelectionOutline();
  });
  pathCancelBtn.addEventListener('click', () => finishPathEdit(false));
  pathDoneBtn.addEventListener('click', () => finishPathEdit(true));
  pathBarEl.addEventListener('pointerdown', e => e.stopPropagation());
  tweenBarCancelBtn.addEventListener('click', () => {
    // a movement opened again: closed as it was
    if (motionEdit) {
      exitMotionEdit();
      return;
    }
    stopTweenPlay();
    tweenEdit = null; // back to the plain selection, the piece stays where it is
    updateSelectionBar();
    drawSelectionOutline();
  });
  tweenBarOkBtn.addEventListener('click', async () => {
    if (!floatingFragment || !tweenEdit) return;
    stopTweenPlay();
    const { frames, easing, bend, path, waypoints } = tweenEdit;
    if (motionEdit) {
      await regenerateMotion(frames, easing, { bend, path, waypoints });
      return;
    }
    tweenEdit = null;
    tweenBarEl.classList.remove('show');
    await generateTween(frames, easing, { bend, path, waypoints });
  });
  tweenBarEl.addEventListener('pointerdown', e => e.stopPropagation());
  regenMotionBtn.addEventListener('click', () => regenerateWithNewLook());
  editMotionBtn.addEventListener('click', () => {
    const m = motionHere();
    if (m) editMotion(m);
  });

  exportBtn.addEventListener('click', async () => {
    stopPlayback();
    const choice = await openExportDialog();
    if (!choice) return;

    if (choice === 'png' || choice === 'png-transparent') {
      showExportProgress('Сохранение…');
      try {
        // transparent: only the drawing, without the background
        const blob = await exportCurrentFramePNG(layerManager, { transparent: choice === 'png-transparent' });
        hideExportDialog();
        await shareOrDownload(blob, `artist-frame-${Date.now()}.png`);
      } catch (e) {
        hideExportDialog();
        alert('Не удалось сохранить PNG: ' + e.message);
      }
      return;
    }

    if (choice === 'backup') {
      showExportProgress('Подготовка бэкапа…');
      try {
        const blob = await exportProjectBackup(layerManager, { docWidth, docHeight, name: projectName, cameraPixels: [layerManager.layers[0].pixelWidth, layerManager.layers[0].pixelHeight] });
        hideExportDialog();
        await shareOrDownload(blob, `artist-backup-${Date.now()}.json`);
      } catch (e) {
        hideExportDialog();
        alert('Не удалось создать бэкап: ' + e.message);
      }
      return;
    }

    // choice === 'mp4'
    if (!isMp4ExportSupported()) {
      alert('Экспорт в MP4 не поддерживается в этом браузере');
      hideExportDialog();
      return;
    }
    showExportProgress('Кодирование… 0%');
    try {
      const blob = await exportAnimationMp4(layerManager, {
        onProgress: (current, total) => updateExportProgress(current, total),
      });
      hideExportDialog();
      await shareOrDownload(blob, `artist-animation-${Date.now()}.mp4`);
    } catch (e) {
      hideExportDialog();
      alert('Не удалось создать MP4: ' + e.message);
    }
  });

  pasteBtn.addEventListener('click', () => {
    if (!clipboard) return;
    const layer = layerManager.activeLayer;
    if (!layer || layer.kind === 'object') return;
    ensureFrameHere(layer);

    dropFloating();
    setTool('lasso');

    const dpr = layer.dpr || 1;
    if (!history.begin(layer, layer.currentFrameIndex)) return;

    floatingFragment = { canvas: clipboard.canvas, x: clipboard.x, y: clipboard.y, w: clipboard.w, h: clipboard.h };
    floatingLayer = layer;
    floatingPasted = true;
    pinFloatingFrame(layer.currentFrame);
    // right where it was copied from
    floatingOffset = { x: 0, y: 0 };
    dragDelta = { x: 0, y: 0 };

    const x0 = clipboard.x / dpr;
    const y0 = clipboard.y / dpr;
    const w0 = clipboard.w / dpr;
    const h0 = clipboard.h / dpr;
    const rect = [{ x: x0, y: y0 }, { x: x0 + w0, y: y0 }, { x: x0 + w0, y: y0 + h0 }, { x: x0, y: y0 + h0 }];
    selection = { regions: [{ mode: 'add', path: rect }], outline: [rect] };
    drawSelectionOutline();
    updateSelectionBar();
    updateHistoryButtons();
  });

  deselectSelBtn.addEventListener('click', () => {
    if (warp) {
      applyWarp();
      return;
    }
    if (floatingFragment) clearSelection();
    else confirmSelection();
  });
  cancelSelBtn.addEventListener('click', cancelSelection);
  selModeBtn.addEventListener('click', () => {
    lassoMode = lassoMode === 'sub' ? 'add' : 'sub';
    updateSelectionBar();
  });

  // ---- long press = eyedropper: a finger held still on the canvas (with
  // a drawing tool) picks the colour under it, whatever's visible there ----
  const HOLD_MS = 450;
  const HOLD_SLOP = 8; // px the finger may wander
  let holdTimer = 0;
  let holdPointerId = null;
  let holdStart = null;

  function cancelHold() {
    clearTimeout(holdTimer);
    holdTimer = 0;
    holdPointerId = null;
  }

  // the colour on screen at a document point: background, then every
  // visible layer's frame there (with its opacity) — not the onion skin,
  // the outside-the-camera dimming or fill borders
  function sampleColorAt(p) {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d');
    const inCamera = p.x >= 0 && p.y >= 0 && p.x < docWidth && p.y < docHeight;
    ctx.fillStyle = layerManager.backgroundMode === 'color' ? (layerManager.backgroundColor || '#ffffff') : '#ffffff';
    ctx.fillRect(0, 0, 1, 1);
    if (inCamera && layerManager.backgroundMode === 'image' && layerManager.backgroundImageBitmap) {
      ctx.save();
      ctx.translate(-Math.floor(p.x), -Math.floor(p.y));
      drawImageCover(ctx, layerManager.backgroundImageBitmap, docWidth, docHeight);
      ctx.restore();
    }
    for (const l of layerManager.layers) {
      const f = l.shownFrame;
      if (!l.visible || l.ended || !f?.resident) continue;
      if (l.encoding === 'jpeg' && !inCamera) continue; // a video layer ends at the camera
      const X = Math.floor(p.x * l.dpr);
      const Y = Math.floor(p.y * l.dpr);
      const tx = Math.floor(X / TILE);
      const ty = Math.floor(Y / TILE);
      const t = f.tiles.get(`${tx},${ty}`);
      if (!t?.canvas) continue;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(t.canvas, X - tx * TILE, Y - ty * TILE, 1, 1, 0, 0, 1, 1);
    }
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    releaseCanvas(c);
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }

  const pickBadge = document.createElement('div');
  pickBadge.className = 'pick-badge';
  canvasWrap.appendChild(pickBadge);
  let pickBadgeTimer = 0;

  function pickColorAt(clientX, clientY) {
    const hex = sampleColorAt(view.screenToDocument(clientX, clientY, viewportCenter()));
    color = hex;
    colorPicker.value = hex;
    // the picked colour, shown just above the finger for a moment
    const r = canvasWrap.getBoundingClientRect();
    pickBadge.style.left = `${clientX - r.left}px`;
    pickBadge.style.top = `${clientY - r.top - 70}px`;
    pickBadge.style.background = hex;
    pickBadge.classList.add('show');
    clearTimeout(pickBadgeTimer);
    pickBadgeTimer = setTimeout(() => pickBadge.classList.remove('show'), 900);
  }

  function onHold() {
    holdTimer = 0;
    if (holdPointerId === null || !activePointers.has(holdPointerId)) return;
    // the press wasn't a stroke / fill after all
    if (mode === 'draw') abortDraw();
    if (mode === 'fillPending') {
      fillPointerId = null;
      fillDownPoint = null;
    }
    mode = 'picked';
    pickColorAt(holdStart.x, holdStart.y);
  }

  canvasWrap.addEventListener('pointerdown', e => {
    // cheap once per touch, and catches any layout shift the observer missed
    if (activePointers.size === 0) refreshViewportCenter();
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvasWrap.setPointerCapture(e.pointerId);
    dlog('down', { n: activePointers.size, type: e.pointerType, tool, mode });

    if (activePointers.size === 1 && mode === 'idle' && activeObject()) {
      // an object layer: the brush / eraser draw on it; otherwise a finger
      // on it moves it (a key here)
      if (tool === 'brush' || tool === 'eraser') beginObjectDraw(e);
      else beginObjectMove(e);
    } else if (activePointers.size === 1 && mode === 'idle') {
      if (tool === 'brush' || tool === 'eraser' || tool === 'fill' || tool === 'guide') {
        cancelHold();
        holdPointerId = e.pointerId;
        holdStart = { x: e.clientX, y: e.clientY };
        holdTimer = setTimeout(onHold, HOLD_MS);
      }
      if (tool === 'fill') {
        mode = 'fillPending';
        fillPointerId = e.pointerId;
        fillDownPoint = { clientX: e.clientX, clientY: e.clientY };
      } else if (tool === 'lasso') {
        const docPt = docPointFromEvent(e);
        if (floatingFragment) {
          // placing path points takes every touch; then the tween path's
          // midpoint handle (it can sit over the piece); then the piece
          if (warp) beginWarpGrab(e, docPt);
          else if (tweenEdit?.editingPath) beginWaypoint(e, docPt);
          else if (nearBendHandle(docPt)) beginBend(e, docPt);
          else if (isInsideSelection(docPt)) beginMoveSelection(e, docPt);
          // touching outside an active selection is ignored — drop it via a button instead
        } else {
          beginLasso(e, docPt);
        }
      } else if (tool === 'poly') {
        beginPolyPoint(e, docPointFromEvent(e));
      } else {
        // (taken back if this touch turns out to be a two-finger zoom)
        strokeMadeFrame = ensureFrameHere(layerManager.activeLayer);
        beginDraw(e);
      }
    } else if (activePointers.size >= 2) {
      cancelHold();
      const ids = Array.from(activePointers.keys()).slice(0, 2);
      const [a, b] = ids.map(id => activePointers.get(id));
      const aDoc = docPointFromEvent({ clientX: a.x, clientY: a.y });
      const bDoc = docPointFromEvent({ clientX: b.x, clientY: b.y });
      // (while placing path points two fingers always move the view)
      const obj = activeObject();
      if (obj && !floatingFragment && tool !== 'brush' && tool !== 'eraser' && (objectHit(obj, aDoc) || objectHit(obj, bDoc))) {
        beginObjectTransform(ids);
      } else if (warp && (insideQuad(warp, aDoc) || insideQuad(warp, bDoc))) {
        beginWarpTwo(ids, aDoc, bDoc);
      } else if (floatingFragment && !warp && !tweenEdit?.editingPath && (isInsideSelection(aDoc) || isInsideSelection(bDoc))) {
        beginTransformSelection();
      } else {
        beginNav();
      }
    }
  });

  canvasWrap.addEventListener('pointermove', e => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerId === holdPointerId && holdStart && Math.hypot(e.clientX - holdStart.x, e.clientY - holdStart.y) > HOLD_SLOP) cancelHold();
    if (mode === 'picked') return;

    if (mode === 'warp' && warpGrab && e.pointerId === warpGrab.id) {
      moveWarpGrab(docPointFromEvent(e));
      return;
    }
    if (mode === 'warpTwo') {
      moveWarpTwo();
      return;
    }
    if (mode === 'draw' && e.pointerId === drawPointerId && strokeRenderer) {
      // every sample since the last event, not just the latest — a fast
      // stroke otherwise loses most of its shape between frames
      const samples = e.getCoalescedEvents?.() ?? [];
      for (const ev of samples.length ? samples : [e]) strokeRenderer.extend(docPointFromEvent(ev), size);
      trackDrawRing(e);
    } else if (mode === 'lasso' && e.pointerId === lassoPointerId) {
      const docPt = docPointFromEvent(e);
      lassoPoints.push(docPt);
      drawSelectionOutline();
      drawLassoInProgress();
    } else if (mode === 'objDraw' && e.pointerId === objDraw?.id) {
      moveObjectDraw(e);
    } else if (mode === 'objMove' && e.pointerId === objGesture?.id) {
      moveObject(e);
    } else if (mode === 'objTransform') {
      transformObject();
    } else if (mode === 'poly' && e.pointerId === polyPointerId) {
      movePolyPoint(e);
    } else if (mode === 'moveSel' && e.pointerId === moveSelPointerId) {
      updateMoveSelection(docPointFromEvent(e));
    } else if (mode === 'bend' && e.pointerId === bendPointerId && tweenEdit) {
      updateBend(docPointFromEvent(e));
    } else if (mode === 'waypoint' && e.pointerId === wpPointerId && tweenEdit?.editingPath) {
      moveWaypoint(e);
    } else if (mode === 'transformSel') {
      updateTransformSelection();
    } else if (mode === 'nav') {
      updateNav();
    }
  });

  function releasePointer(e) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.delete(e.pointerId);
    dlog('up', { n: activePointers.size, mode, ev: e.type });
    if (e.pointerId === holdPointerId) cancelHold();
    if (mode === 'picked') {
      if (activePointers.size === 0) mode = 'idle';
      return;
    }

    if (mode === 'draw' && e.pointerId === drawPointerId) {
      finishDraw();
      mode = 'idle';
    } else if (mode === 'fillPending' && e.pointerId === fillPointerId) {
      doFill(fillDownPoint);
      fillPointerId = null;
      fillDownPoint = null;
      mode = 'idle';
    } else if (mode === 'lasso' && e.pointerId === lassoPointerId) {
      finishLasso();
      mode = 'idle';
    } else if (mode === 'objDraw' && e.pointerId === objDraw?.id) {
      endObjectDraw();
      mode = 'idle';
    } else if (mode === 'objMove' && e.pointerId === objGesture?.id) {
      endObjectGesture();
      mode = 'idle';
    } else if (mode === 'objTransform') {
      // the pose so far becomes the key; the other finger does nothing more
      endObjectGesture();
      mode = activePointers.size ? 'picked' : 'idle';
    } else if (mode === 'poly' && e.pointerId === polyPointerId) {
      mode = 'idle';
      endPolyPoint();
    } else if (mode === 'moveSel' && e.pointerId === moveSelPointerId) {
      finishMoveSelection(docPointFromEvent(e));
      mode = 'idle';
    } else if (mode === 'warp' && e.pointerId === warpGrab?.id) {
      warpGrab = null;
      mode = 'idle';
    } else if (mode === 'warpTwo') {
      // the shape so far stays; the other finger does nothing more
      warpTwo = null;
      mode = activePointers.size ? 'picked' : 'idle';
    } else if (mode === 'bend' && e.pointerId === bendPointerId) {
      bendPointerId = null;
      mode = 'idle';
    } else if (mode === 'waypoint' && e.pointerId === wpPointerId) {
      mode = 'idle';
      if (tweenEdit?.editingPath) endWaypoint(e);
    } else if (mode === 'transformSel') {
      settleTransformSelection();
      if (activePointers.size < 2) {
        mode = 'idle';
        transformIds = [];
        transformPrev = null;
      } else {
        transformIds = Array.from(activePointers.keys()).slice(0, 2);
        const [a, b] = transformIds.map(id => activePointers.get(id));
        transformPrev = { centroid: centroid(a, b), dist: distance(a, b), angle: angle(a, b) };
      }
      drawSelectionOutline();
    } else if (mode === 'nav') {
      if (activePointers.size < 2) {
        mode = 'idle';
        dlog('nav-end', { scale: +view.scale.toFixed(3) });
        navIds = [];
        navPrev = null;
      } else {
        navIds = Array.from(activePointers.keys()).slice(0, 2);
        const [a, b] = navIds.map(id => activePointers.get(id));
        navPrev = { centroid: centroid(a, b), dist: distance(a, b), angle: angle(a, b) };
      }
    }
  }

  canvasWrap.addEventListener('pointerup', releasePointer);
  canvasWrap.addEventListener('pointercancel', releasePointer);
  canvasWrap.addEventListener('pointerleave', releasePointer);

  canvasWrap.addEventListener('wheel', e => {
    e.preventDefault();
    const vc = viewportCenter();
    const anchorDoc = view.screenToDocument(e.clientX, e.clientY, vc);

    if (e.shiftKey) {
      view.rotation += e.deltaY * 0.002;
    } else {
      view.setScaleClamped(view.scale * Math.exp(-e.deltaY * 0.001));
    }

    view.reanchor(vc, anchorDoc, e.clientX, e.clientY);
    applyView();
    if (ringHover) updateHoverRing(); // zoom changed the on-screen size
  }, { passive: false });

  window.addEventListener('resize', () => {
    refreshViewportCenter();
    applyView();
  });

  // the canvas area also changes size without the window doing so — the
  // timeline grows a row per added layer (or video import), the layers
  // toggle etc. — and the layer stack, centred in it by CSS, moves with it.
  // Touch → document mapping must follow, or strokes land off the finger.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => refreshViewportCenter()).observe(canvasWrap);
  }
}

main();
