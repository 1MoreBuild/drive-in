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
}

function startProgressReporting() {
  stopProgressReporting();
  state.progressInterval = setInterval(() => reportProgress(), 10000);
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

  p.on(AVPlayerEvents.LOADING, () => showBuffering());
  p.on(AVPlayerEvents.LOADED, () => hideBuffering());
  p.on(AVPlayerEvents.FIRST_VIDEO_RENDERED, () => hideBuffering());
  p.on(AVPlayerEvents.SEEKING, () => showBuffering());
  p.on(AVPlayerEvents.SEEKED, () => hideBuffering());

  p.on(AVPlayerEvents.TIME, (pts) => {
    if (isDraggingProgress()) return;
    state.currentTime = Number(pts) / 1000;
    if (state.duration > 0) state.currentTime = Math.min(state.currentTime, state.duration);
    if (state.duration > 0) {
      updateProgress(state.currentTime / state.duration);
    }
    updateTimeDisplay();
    renderSubtitle(state.currentTime);
    if (state.isBuffering) hideBuffering();
  });

  p.on(AVPlayerEvents.PLAYING, () => {
    state.isPlaying = true;
    updatePlayButton();
    updateMediaSession();
    hideBuffering();
  });

  p.on(AVPlayerEvents.PAUSED, () => {
    state.isPlaying = false;
    updatePlayButton();
    updateMediaSession();
  });

  p.on(AVPlayerEvents.ENDED, () => {
    state.isPlaying = false;
    state.currentTime = 0;
    reportProgress();
    updatePlayButton();
    updateMediaSession();
    showControls();
  });

  p.on(AVPlayerEvents.ERROR, (err) => {
    console.error("[player] Error event:", err);
    hideBuffering();
  });

  p.on(AVPlayerEvents.TIMEOUT, () => {
    console.warn("[player] Timeout — network may be slow");
  });
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

    if (state.player) {
      try { await state.player.stop(); } catch {}
      state.player = null;
    }

    container.innerHTML = "";
    disableExternalSubtitle();
    state.currentTime = meta.startTime || 0;
    state.duration = meta.duration || 0;
    state.plexInfo = meta.plex || null;
    updateTimeDisplay();
    updateProgress(0);
    onUpdateSubsUI();
    onUpdateAudioUI();
    subsPanel.classList.add("hidden");
    audioPanel.classList.add("hidden");
    mediaTitle.textContent = title || "";

    overlay.classList.add("hidden");
    showBuffering();
    navigate("/play", true);

    state.player = new AVPlayerClass({
      container,
      enableHardware: true,
      enableWebGPU: false,
      enableWebCodecs: true,
      enableWorker: false,
      preLoadTime: 600,
    });

    bindPlayerEvents(state.player);
    startProgressReporting();

    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    console.log("[player] Loading:", absUrl);
    await state.player.load(absUrl, { isLive: meta.isLive || false });

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
    showStatus(`Error: ${e.message}`);
  } finally {
    state.playLock = false;
  }
}

export async function stop() {
  reportProgress();
  stopProgressReporting();
  try { await state.player?.stop(); } catch {}
  state.player = null;
  container.innerHTML = "";
  state.isPlaying = false;
  if (mediaSessionAudio) mediaSessionAudio.pause();
  state.currentTime = 0;
  state.duration = 0;
  state.externalSubs = [];
  state.activeExternalSubs.clear();
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
