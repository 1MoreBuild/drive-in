import { state } from "./state.js";
import {
  showControls, updateTimeDisplay, updateProgress, updatePlayButton,
  updateVolumeButton, showBuffering, hideBuffering, isDraggingProgress,
  mediaTitle,
} from "./controls.js";
import { renderSubtitle, disableExternalSubtitle } from "./subtitles.js";
import { navigate } from "./router.js";

// --- Callbacks (set by main.js to avoid circular deps) ---------------

let onUpdateSubsUI = () => {};
let onUpdateAudioUI = () => {};

export function setPlayerCallbacks({ updateSubsUI, updateAudioUI }) {
  onUpdateSubsUI = updateSubsUI;
  onUpdateAudioUI = updateAudioUI;
}

// --- AVPlayer class loader -------------------------------------------

let AVPlayerClass = null;
let AVPlayerEvents = null;
let currentPlayerBindings = null;
let lastUiPaintAt = 0;

const UI_PAINT_INTERVAL_MS = 250;
// Minimal WASM module using a v128.const SIMD instruction.
// Compiling this module will fail at runtime when SIMD is disabled (e.g. Tesla
// browser), whereas WebAssembly.validate() may still accept the bytecode.
const WASM_SIMD_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,  // magic + version
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,          // type section: () -> v128
  0x03, 0x02, 0x01, 0x00,                              // function section
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00,            // code section
  0xfd, 0x0f, 0xfd, 0x0c, 0x0b,                        // v128.const + end
]);
const CAPABILITY_PROFILE = detectCapabilityProfile();
const PROGRESS_REPORT_INTERVAL_MS = 10_000;
const playerMetricsState = createPlayerMetricsState();

function defaultDecodePath() {
  return CAPABILITY_PROFILE.hasVideoDecoder
    ? "prefer-webcodecs-hardware"
    : CAPABILITY_PROFILE.hasWebCodecs
      ? "prefer-webcodecs"
      : "wasm-fallback";
}

function createPlayerMetricsState() {
  return {
    stallCount: 0,
    totalStallDurationMs: 0,
    stallStartedAt: 0,
    decodePath: defaultDecodePath(),
  };
}

function resetPlayerMetrics() {
  playerMetricsState.stallCount = 0;
  playerMetricsState.totalStallDurationMs = 0;
  playerMetricsState.stallStartedAt = 0;
  playerMetricsState.decodePath = defaultDecodePath();
}

function beginStall() {
  if (playerMetricsState.stallStartedAt) return;
  playerMetricsState.stallCount += 1;
  playerMetricsState.stallStartedAt = performance.now();
}

function endStall() {
  if (!playerMetricsState.stallStartedAt) return;
  playerMetricsState.totalStallDurationMs += performance.now() - playerMetricsState.stallStartedAt;
  playerMetricsState.stallStartedAt = 0;
}

function getPlaybackState() {
  if (!state.player) return "idle";
  if (state.isBuffering) return "buffering";
  return state.isPlaying ? "playing" : "paused";
}

function toMetricSeconds(value) {
  if (typeof value === "bigint") return Number(value) / 1000;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const maxKnownSeconds = Math.max(state.duration || 0, state.currentTime || 0);
  return value > maxKnownSeconds + 120 ? value / 1000 : value;
}

function normalizeBufferedSeconds(value) {
  if (value == null) return null;

  if (typeof value === "number" || typeof value === "bigint") {
    const endSeconds = toMetricSeconds(value);
    return endSeconds == null ? null : Math.max(0, endSeconds - state.currentTime);
  }

  if (Array.isArray(value)) {
    for (const range of value) {
      const normalized = normalizeBufferedSeconds(range);
      if (normalized != null) return normalized;
    }
    return null;
  }

  if (typeof value.length === "number" && typeof value.start === "function" && typeof value.end === "function") {
    for (let i = 0; i < value.length; i++) {
      const start = toMetricSeconds(value.start(i));
      const end = toMetricSeconds(value.end(i));
      if (start == null || end == null) continue;
      if (end >= state.currentTime && (start == null || start <= state.currentTime + 1)) {
        return Math.max(0, end - state.currentTime);
      }
    }
    return null;
  }

  if (typeof value === "object") {
    if ("bufferHealthSeconds" in value) return normalizeBufferedSeconds(value.bufferHealthSeconds);
    if ("bufferedSeconds" in value) return normalizeBufferedSeconds(value.bufferedSeconds);
    if ("bufferedDuration" in value) return normalizeBufferedSeconds(value.bufferedDuration);
    if ("seconds" in value) return normalizeBufferedSeconds(value.seconds);
    if ("end" in value) {
      const end = toMetricSeconds(value.end);
      const start = "start" in value ? toMetricSeconds(value.start) : state.currentTime;
      if (end == null) return null;
      return Math.max(0, end - Math.max(start ?? state.currentTime, state.currentTime));
    }
  }

  return null;
}

function readBufferHealthSeconds(player) {
  const readers = [
    () => player?.getBuffered?.(),
    () => player?.getBufferedEnd?.(),
    () => player?.getBufferRange?.(),
    () => player?.getStats?.(),
    () => player?.buffered,
    () => player?.video?.buffered,
    () => player?.videoElement?.buffered,
  ];

  for (const read of readers) {
    try {
      const bufferedSeconds = normalizeBufferedSeconds(read());
      if (bufferedSeconds != null) return bufferedSeconds;
    } catch {}
  }

  return null;
}

function normalizeDroppedFrames(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "object") {
    for (const key of ["droppedFrames", "droppedVideoFrames", "dropped", "droppedCount"]) {
      if (key in value) return normalizeDroppedFrames(value[key]);
    }
  }
  return null;
}

function readDroppedFrames(player) {
  const readers = [
    () => player?.getDroppedFrames?.(),
    () => player?.getStats?.(),
    () => player?.getVideoPlaybackQuality?.(),
    () => player?.video?.getVideoPlaybackQuality?.(),
    () => player?.videoElement?.getVideoPlaybackQuality?.(),
  ];

  for (const read of readers) {
    try {
      const droppedFrames = normalizeDroppedFrames(read());
      if (droppedFrames != null) return droppedFrames;
    } catch {}
  }

  return null;
}

function reportPlayerMetrics() {
  const activeStallDurationMs = playerMetricsState.stallStartedAt
    ? performance.now() - playerMetricsState.stallStartedAt
    : 0;
  const bufferHealthSeconds = readBufferHealthSeconds(state.player);
  const droppedFrames = readDroppedFrames(state.player);

  fetch("/api/metrics/player", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      currentTime: state.currentTime,
      duration: state.duration,
      isPlaying: state.isPlaying,
      isMuted: state.isMuted,
      bufferHealthSeconds,
      stallCount: playerMetricsState.stallCount,
      totalStallDurationMs: Math.round(playerMetricsState.totalStallDurationMs + activeStallDurationMs),
      decodePath: playerMetricsState.decodePath,
      droppedFrames,
      playbackState: getPlaybackState(),
      capabilityProfile: {
        hasWebCodecs: CAPABILITY_PROFILE.hasWebCodecs,
        hasVideoDecoder: CAPABILITY_PROFILE.hasVideoDecoder,
        enableWorker: CAPABILITY_PROFILE.enableWorker,
        hasAudioWorklet: CAPABILITY_PROFILE.hasAudioWorklet,
        teslaLikeEnv: CAPABILITY_PROFILE.teslaLikeEnv,
      },
    }),
  }).catch(() => {});
}

function detectWasmSIMD() {
  try {
    // Actually compile a SIMD module rather than just validating bytecode.
    // WebAssembly.validate() can return true even when the engine disables SIMD
    // at runtime (observed on Tesla's Chromium 136 browser).
    return !!new WebAssembly.Module(WASM_SIMD_MODULE);
  } catch {
    return false;
  }
}

function detectWasmThreads() {
  try {
    if (typeof SharedArrayBuffer === "undefined" || typeof WebAssembly?.Memory !== "function") {
      return false;
    }
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return memory.buffer instanceof SharedArrayBuffer;
  } catch {
    return false;
  }
}

function detectCapabilityProfile() {
  const userAgent = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  const platformText = `${platform} ${userAgent}`;
  const isLinuxX64 = /linux/i.test(platformText) && /(x86_64|x64|amd64)/i.test(platformText);
  const hasVideoDecoder = typeof globalThis.VideoDecoder === "function";
  const hasAudioDecoder = typeof globalThis.AudioDecoder === "function";
  const hasWebCodecs = hasVideoDecoder || hasAudioDecoder;
  const hasAudioContext = typeof (globalThis.AudioContext || globalThis.webkitAudioContext) === "function";
  const hasAudioWorklet = hasAudioContext && typeof globalThis.AudioWorkletNode === "function";
  const hasWorkers = typeof globalThis.Worker === "function";
  const hasOffscreenCanvas = typeof globalThis.OffscreenCanvas === "function";
  const hasWasmSIMD = detectWasmSIMD();
  const hasWasmThreads = detectWasmThreads();
  const constrainedWebCodecsEnv = hasWebCodecs && !hasWasmSIMD;

  return {
    platform,
    userAgent,
    isLinuxX64,
    hasVideoDecoder,
    hasAudioDecoder,
    hasWebCodecs,
    hasAudioWorklet,
    hasWorkers,
    hasOffscreenCanvas,
    hasWasmSIMD,
    hasWasmThreads,
    constrainedWebCodecsEnv,
    teslaLikeEnv: isLinuxX64 && constrainedWebCodecsEnv,
    enableWorker: hasWorkers && hasOffscreenCanvas && !hasWasmThreads,
    preLoadTime: constrainedWebCodecsEnv ? 20 : hasWebCodecs ? 30 : 45,
    audioWorkletBufferLength: hasAudioWorklet && constrainedWebCodecsEnv ? 24 : undefined,
  };
}

function getPlayerOptions(container) {
  return {
    container,
    enableHardware: CAPABILITY_PROFILE.hasVideoDecoder,
    enableWebGPU: false,
    enableWebCodecs: CAPABILITY_PROFILE.hasWebCodecs,
    // In no-thread environments, worker mode still moves demux/render work off the UI thread.
    enableWorker: CAPABILITY_PROFILE.enableWorker,
    enableAudioWorklet: CAPABILITY_PROFILE.hasAudioWorklet,
    // Keep VOD buffering tighter when WebCodecs is the preferred path to avoid excess memory pressure.
    preLoadTime: CAPABILITY_PROFILE.preLoadTime,
    ...(CAPABILITY_PROFILE.audioWorkletBufferLength
      ? { audioWorkletBufferLength: CAPABILITY_PROFILE.audioWorkletBufferLength }
      : {}),
  };
}

function reportDecodeInfo(data) {
  if (data?.path) playerMetricsState.decodePath = data.path;
  fetch("/api/dev/decode-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch(() => {});
}

async function logDecodePath(player, phase) {
  const summary = {
    phase,
    webCodecsEnabled: CAPABILITY_PROFILE.hasWebCodecs,
    hardwareAccelerationRequested: CAPABILITY_PROFILE.hasVideoDecoder,
    constrainedWebCodecsEnv: CAPABILITY_PROFILE.constrainedWebCodecsEnv,
  };

  try {
    const tasks = await player?.VideoPipelineProxy?.VideoDecodePipeline?.getTasksInfo?.();
    if (Array.isArray(tasks) && tasks.length > 0) {
      const usesHardwareDecoder = tasks.some((task) => task?.hardware === true);
      const decodeInfo = {
        ...summary,
        path: usesHardwareDecoder
          ? "webcodecs-hardware"
          : CAPABILITY_PROFILE.hasWebCodecs
            ? "webcodecs-or-wasm-fallback"
            : "wasm",
        tasks: tasks.map((task) => ({
          codecId: task.codecId,
          width: task.width,
          height: task.height,
          framerate: task.framerate,
          hardware: task.hardware,
        })),
      };
      console.log("[player] Decoder path:", decodeInfo);
      reportDecodeInfo(decodeInfo);
      return decodeInfo;
    }
  } catch (error) {
    console.warn("[player] Failed to inspect decoder path:", error);
  }

  const decodeInfo = {
    ...summary,
    path: CAPABILITY_PROFILE.hasWebCodecs
      ? "webcodecs-requested"
      : "wasm-only",
  };
  console.log("[player] Decoder path:", decodeInfo);
  reportDecodeInfo(decodeInfo);
  return decodeInfo;
}

async function loadAVPlayerClass() {
  if (AVPlayerClass) return;
  const mod = await import("@libmedia/avplayer");
  AVPlayerClass = mod.default || mod.AVPlayer || mod;
  AVPlayerEvents = mod.Events;
  console.log("[player] AVPlayer class loaded");
}

// --- MediaSession (Tesla steering wheel / browser media keys) --------

let mediaSessionAudio = null;

function ensureMediaSessionAudio() {
  if (mediaSessionAudio) return mediaSessionAudio;
  const silentWav = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
  mediaSessionAudio = document.createElement("audio");
  mediaSessionAudio.src = silentWav;
  mediaSessionAudio.loop = true;
  mediaSessionAudio.volume = 0.01;
  return mediaSessionAudio;
}

function syncMediaSessionPlayback() {
  if (!mediaSessionAudio) return;
  if (state.isPlaying) {
    mediaSessionAudio.play().catch(() => {});
  } else {
    mediaSessionAudio.pause();
  }
}

export function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: mediaTitle.textContent || "Drive-In",
  });
  navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
  if (state.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        playbackRate: 1,
        position: Math.min(state.currentTime, state.duration),
      });
    } catch {}
  }
  syncMediaSessionPlayback();
}

// --- Progress reporting ----------------------------------------------

export function reportProgress() {
  const ps = {
    currentTime: state.currentTime,
    duration: state.duration,
    isPlaying: state.isPlaying,
    isMuted: state.isMuted,
    plexRatingKey: state.plexInfo?.ratingKey || null,
  };
  if (state.ws?.readyState === 1) {
    state.ws.send(JSON.stringify({ type: "playerState", ...ps }));
  }
  if (state.plexInfo?.ratingKey) {
    fetch("/api/plex/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ratingKey: state.plexInfo.ratingKey,
        timeMs: state.currentTime * 1000,
      }),
    }).catch(() => {});
  }
  reportPlayerMetrics();
}

function unbindPlayerEvents(player) {
  if (!player || !AVPlayerEvents || !currentPlayerBindings) return;
  for (const [event, handler] of currentPlayerBindings) {
    player.off(event, handler);
  }
  currentPlayerBindings = null;
}

async function disposePlayer(player) {
  if (!player) return;
  // Fully destroy old AVPlayer instances so canvases, audio nodes, and worker state do not leak across plays.
  unbindPlayerEvents(player);
  try { await player.stop(true); } catch {}
  try { await player.destroy(); } catch {}
}

function startProgressReporting() {
  stopProgressReporting();
  state.progressInterval = setInterval(() => reportProgress(), PROGRESS_REPORT_INTERVAL_MS);
}

function stopProgressReporting() {
  if (state.progressInterval) {
    clearInterval(state.progressInterval);
    state.progressInterval = null;
  }
}

// --- Seek ------------------------------------------------------------

export function seekToTime(timeSec) {
  if (!state.player || state.duration <= 0) return;
  state.currentTime = Math.max(0, Math.min(state.duration, timeSec));
  updateTimeDisplay();
  updateProgress(state.currentTime / state.duration);
  state.player.seek(BigInt(Math.floor(state.currentTime * 1000))).then(() => {
    if (state.isPlaying) state.player.resume().catch(() => {});
  }).catch((err) => console.error("[player] Seek error:", err));
  reportProgress();
}

// --- Toggle play/pause -----------------------------------------------

export async function togglePlayPause() {
  if (!state.player) return;
  try {
    const status = state.player.getStatus();
    const actuallyPlaying = status === 5 || status === 6;
    if (actuallyPlaying) {
      await state.player.pause();
      state.isPlaying = false;
    } else {
      await state.player.play();
      state.isPlaying = true;
    }
    updatePlayButton();
  } catch (e) {
    console.error("[player] Toggle error:", e);
  }
}

// --- Player event bindings -------------------------------------------

function bindPlayerEvents(p) {
  if (!AVPlayerEvents) return;

  const onLoading = () => {
    beginStall();
    showBuffering();
  };
  const onLoaded = () => {
    endStall();
    hideBuffering();
  };
  const onFirstVideoRendered = () => {
    endStall();
    hideBuffering();
    logDecodePath(p, "first-video-frame");
  };
  const onSeeking = () => showBuffering();
  const onSeeked = () => hideBuffering();
  const onTime = (pts) => {
    if (isDraggingProgress()) return;
    state.currentTime = Number(pts) / 1000;
    if (state.duration > 0) state.currentTime = Math.min(state.currentTime, state.duration);

    const now = performance.now();
    if (now - lastUiPaintAt >= UI_PAINT_INTERVAL_MS) {
      // Throttle control repaint work so the TIME event does not force DOM writes on every decoded frame.
      if (state.duration > 0) {
        updateProgress(state.currentTime / state.duration);
      }
      updateTimeDisplay();
      lastUiPaintAt = now;
    }

    renderSubtitle(state.currentTime);
    if (state.isBuffering) hideBuffering();
  };
  const onPlaying = () => {
    endStall();
    state.isPlaying = true;
    updatePlayButton();
    updateMediaSession();
    hideBuffering();
  };
  const onPaused = () => {
    endStall();
    state.isPlaying = false;
    updatePlayButton();
    updateMediaSession();
  };
  const onEnded = () => {
    endStall();
    state.isPlaying = false;
    state.currentTime = 0;
    reportProgress();
    updatePlayButton();
    updateMediaSession();
    showControls();
  };
  const onError = (err) => {
    endStall();
    console.error("[player] Error event:", err);
    hideBuffering();
  };
  const onTimeout = () => {
    console.warn("[player] Timeout — network may be slow");
  };

  currentPlayerBindings = [
    [AVPlayerEvents.LOADING, onLoading],
    [AVPlayerEvents.LOADED, onLoaded],
    [AVPlayerEvents.FIRST_VIDEO_RENDERED, onFirstVideoRendered],
    [AVPlayerEvents.SEEKING, onSeeking],
    [AVPlayerEvents.SEEKED, onSeeked],
    [AVPlayerEvents.TIME, onTime],
    [AVPlayerEvents.PLAYING, onPlaying],
    [AVPlayerEvents.PAUSED, onPaused],
    [AVPlayerEvents.ENDED, onEnded],
    [AVPlayerEvents.ERROR, onError],
    [AVPlayerEvents.TIMEOUT, onTimeout],
  ];

  for (const [event, handler] of currentPlayerBindings) {
    p.on(event, handler);
  }
}

// --- Play / Stop -----------------------------------------------------

const container = document.getElementById("player-container");
const overlay = document.getElementById("overlay");
const statusText = document.getElementById("status-text");
const subsPanel = document.getElementById("subs-panel");
const audioPanel = document.getElementById("audio-panel");
const btnAudio = document.getElementById("btn-audio");

export function showStatus(text) {
  statusText.textContent = text;
  overlay.classList.remove("hidden");
}

export async function play(url, title, meta = {}) {
  if (state.playLock) return;
  state.playLock = true;

  try {
    await loadAVPlayerClass();
    resetPlayerMetrics();

    if (state.player) {
      await disposePlayer(state.player);
      state.player = null;
    }

    container.innerHTML = "";
    disableExternalSubtitle();
    state.currentTime = meta.startTime || 0;
    state.duration = meta.duration || 0;
    state.plexInfo = meta.plex || null;
    state.sourceUrl = meta.sourceUrl || null;
    lastUiPaintAt = 0;
    updateTimeDisplay();
    updateProgress(state.duration > 0 ? state.currentTime / state.duration : 0);
    onUpdateSubsUI();
    onUpdateAudioUI();
    subsPanel.classList.add("hidden");
    audioPanel.classList.add("hidden");
    mediaTitle.textContent = title || "";

    overlay.classList.add("hidden");
    showBuffering();
    // Include source in URL so page refresh can resume playback
    const playPath = meta.plex?.ratingKey
      ? `/play?plex=${encodeURIComponent(meta.plex.ratingKey)}`
      : meta.sourceUrl
        ? `/play?url=${encodeURIComponent(meta.sourceUrl)}`
        : "/play";
    navigate(playPath, true);

    const playerOptions = getPlayerOptions(container);
    state.player = new AVPlayerClass(playerOptions);
    const decodeInfo = {
      options: {
        enableHardware: playerOptions.enableHardware,
        enableWebCodecs: playerOptions.enableWebCodecs,
        enableWorker: playerOptions.enableWorker,
        enableAudioWorklet: playerOptions.enableAudioWorklet,
        preLoadTime: playerOptions.preLoadTime,
        audioWorkletBufferLength: playerOptions.audioWorkletBufferLength ?? "default",
      },
      capabilities: {
        isLinuxX64: CAPABILITY_PROFILE.isLinuxX64,
        teslaLikeEnv: CAPABILITY_PROFILE.teslaLikeEnv,
        hasVideoDecoder: CAPABILITY_PROFILE.hasVideoDecoder,
        hasAudioDecoder: CAPABILITY_PROFILE.hasAudioDecoder,
        hasWasmSIMD: CAPABILITY_PROFILE.hasWasmSIMD,
        hasWasmThreads: CAPABILITY_PROFILE.hasWasmThreads,
      },
      decodePreference: CAPABILITY_PROFILE.hasVideoDecoder
        ? "prefer-webcodecs-hardware"
        : CAPABILITY_PROFILE.hasWebCodecs
          ? "prefer-webcodecs"
          : "wasm-fallback",
    };
    console.log("[player] AVPlayer created", decodeInfo);
    reportDecodeInfo(decodeInfo);

    bindPlayerEvents(state.player);
    startProgressReporting();

    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    console.log("[player] Loading:", absUrl);
    await state.player.load(absUrl, { isLive: meta.isLive || false });
    await logDecodePath(state.player, "post-load");

    if (!state.duration) {
      try {
        const d = state.player.getDuration();
        if (d && d > 0n) {
          state.duration = Number(d) / 1000;
          updateTimeDisplay();
        }
      } catch {}
    }

    if (!state.audioUnlocked) {
      state.player.setVolume(0);
      state.isMuted = true;
      updateVolumeButton();
    }

    await state.player.play();
    if (state.currentTime > 5) {
      const seekMs = BigInt(Math.floor(state.currentTime * 1000));
      try { await state.player.seek(seekMs); } catch (e) { console.warn("[player] Seek failed:", e); }
    }
    state.isPlaying = true;
    updatePlayButton();
    hideBuffering();
    showControls();
    ensureMediaSessionAudio();
    updateMediaSession();

  } catch (e) {
    console.error("[player] Playback error:", e);
    stopProgressReporting();
    // Tear down partially initialized players on failure so retry loops do not retain wasm/render resources.
    const failedPlayer = state.player;
    state.player = null;
    await disposePlayer(failedPlayer);
    showStatus(`Error: ${e.message}`);
  } finally {
    state.playLock = false;
  }
}

export async function stop() {
  endStall();
  reportProgress();
  stopProgressReporting();
  const player = state.player;
  state.player = null;
  await disposePlayer(player);
  container.innerHTML = "";
  state.isPlaying = false;
  state.sourceUrl = null;
  if (mediaSessionAudio) mediaSessionAudio.pause();
  state.currentTime = 0;
  state.duration = 0;
  state.externalSubs = [];
  state.activeExternalSubs.clear();
  // Clear subtitle cues on stop so large parsed VTT arrays are released as soon as playback ends.
  disableExternalSubtitle();
  lastUiPaintAt = 0;
  updatePlayButton();
  updateTimeDisplay();
  updateProgress(0);
  mediaTitle.textContent = "";
  overlay.classList.remove("hidden");
  document.getElementById("app").classList.remove("controls-visible");
  hideBuffering();
  navigate("/");
}

// --- MediaSession action handlers ------------------------------------

export function initMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => {
    if (state.player && !state.isPlaying) {
      state.player.play().catch(() => {});
      state.isPlaying = true;
      updatePlayButton();
      updateMediaSession();
      syncMediaSessionPlayback();
    }
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    if (state.player && state.isPlaying) {
      state.player.pause().catch(() => {});
      state.isPlaying = false;
      updatePlayButton();
      updateMediaSession();
      syncMediaSessionPlayback();
    }
  });
  navigator.mediaSession.setActionHandler("stop", () => {
    stop();
  });
}
