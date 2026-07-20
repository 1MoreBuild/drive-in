import { state } from "./state.js";
import { fmt } from "./utils.js";

// --- DOM elements ----------------------------------------------------

const app = document.getElementById("app");
const btnCenterPlay = document.getElementById("btn-center-play");
const btnVolume = document.getElementById("btn-volume");
const timeCurrent = document.getElementById("time-current");
const timeSep = document.getElementById("time-sep");
const timeDuration = document.getElementById("time-duration");
const btnLiveEdge = document.getElementById("btn-live-edge");
const progressWrap = document.getElementById("progress-wrap");
const progressPlayed = document.getElementById("progress-played");
const progressScrubber = document.getElementById("progress-scrubber");
const seekIndicatorLeft = document.getElementById("seek-indicator-left");
const seekIndicatorRight = document.getElementById("seek-indicator-right");
const playbackNotice = document.getElementById("playback-notice");
const btnSubs = document.getElementById("btn-subs");
const subsPanel = document.getElementById("subs-panel");
const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
export const mediaTitle = document.getElementById("media-title");

// --- Controls visibility (auto-hide) ---------------------------------

let hideTimer = null;

export function showControls() {
  app.classList.add("controls-visible");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideControls, 3000);
}

function hideControls() {
  if (progressWrap.classList.contains("dragging")) return;
  if (!subsPanel.classList.contains("hidden")) return;
  if (!audioPanel.classList.contains("hidden")) return;
  app.classList.remove("controls-visible");
}

// --- Time / progress display -----------------------------------------

let lastCurrentTimeText = "";
let lastDurationText = "";
let lastProgressPct = "";
// Compensate for WebCodecs seek warm-up by targeting a real segment from the
// bounded future runway exposed by the HLS proxy.
const LIVE_SEEK_LEAD_SECONDS = 11;

export function updateTimeDisplay() {
  const hasLiveTimeline = state.isLive
    && state.liveDvrAvailable
    && state.liveEdgeTime > state.liveStartTime;
  const liveLatency = hasLiveTimeline ? state.liveEdgeTime - state.currentTime : Infinity;
  const atLiveEdge = liveLatency <= 10;
  const nextCurrentTimeText = state.isLive
    ? hasLiveTimeline && !atLiveEdge
      ? fmt(Math.max(0, state.currentTime - state.liveStartTime))
      : ""
    : fmt(state.currentTime);
  const nextDurationText = state.isLive ? "" : fmt(state.duration);

  if (nextCurrentTimeText !== lastCurrentTimeText || timeCurrent.textContent !== nextCurrentTimeText) {
    lastCurrentTimeText = nextCurrentTimeText;
    timeCurrent.textContent = nextCurrentTimeText;
  }
  if (nextDurationText !== lastDurationText || timeDuration.textContent !== nextDurationText) {
    lastDurationText = nextDurationText;
    timeDuration.textContent = nextDurationText;
  }
  timeSep.classList.toggle("hidden", state.isLive);
  btnLiveEdge.classList.toggle("hidden", !state.isLive);
  btnLiveEdge.disabled = atLiveEdge;
  btnLiveEdge.classList.toggle("at-edge", atLiveEdge);

  const seekStart = hasLiveTimeline ? state.liveStartTime : 0;
  const seekEnd = hasLiveTimeline ? state.liveEdgeTime : state.duration;
  progressWrap.setAttribute("aria-valuemin", "0");
  progressWrap.setAttribute("aria-valuemax", String(Math.max(0, Math.round(seekEnd - seekStart))));
  progressWrap.setAttribute("aria-valuenow", String(Math.max(0, Math.round(state.currentTime - seekStart))));
  progressWrap.setAttribute("aria-valuetext", state.isLive
    ? atLiveEdge ? "Live" : `${fmt(Math.max(0, state.currentTime - seekStart))} from start`
    : `${fmt(state.currentTime)} of ${fmt(state.duration)}`);
}

export function updateProgress(fraction) {
  const clampedFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const pct = `${(clampedFraction * 100).toFixed(3)}%`;
  if (pct === lastProgressPct) return;
  lastProgressPct = pct;
  progressPlayed.style.width = pct;
  progressScrubber.style.left = pct;
}

// --- Play button state -----------------------------------------------

export function updatePlayButton() {
  btnCenterPlay.classList.toggle("paused", !state.isPlaying);
}

// --- Volume button state ---------------------------------------------

export function updateVolumeButton() {
  btnVolume.classList.toggle("muted", state.isMuted);
}

// --- Buffering state -------------------------------------------------

export function showBuffering() {
  state.isBuffering = true;
  btnCenterPlay.classList.add("buffering");
}

export function hideBuffering() {
  state.isBuffering = false;
  btnCenterPlay.classList.remove("buffering");
}

export function showPlaybackNotice(text) {
  if (!playbackNotice || !text) return;
  playbackNotice.textContent = text;
  playbackNotice.classList.remove("hidden");
}

export function hidePlaybackNotice() {
  if (!playbackNotice) return;
  playbackNotice.textContent = "";
  playbackNotice.classList.add("hidden");
}

// --- Double-tap seek indicator ---------------------------------------

function flashSeek(side, accum) {
  const el = side === "right" ? seekIndicatorRight : seekIndicatorLeft;
  el.textContent = side === "right" ? `+${accum}s \u203A` : `\u2039 -${accum}s`;
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// --- Init (wires up event listeners with callbacks) ------------------

let isDragging = false;

export function isDraggingProgress() {
  return isDragging;
}

export function initControls({ onTogglePlayPause, onStop, onSeekToTime, onSetVolume }) {
  // Pointer movement shows controls
  app.addEventListener("pointermove", showControls);
  app.addEventListener("pointerdown", showControls);

  // Play/pause button
  btnCenterPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    onTogglePlayPause();
  });

  // Back button
  document.getElementById("btn-back").addEventListener("click", (e) => {
    e.stopPropagation();
    onStop();
  });

  // Volume button
  btnVolume.addEventListener("click", (e) => {
    e.stopPropagation();
    state.isMuted = !state.isMuted;
    onSetVolume(state.isMuted ? 0 : 1);
    updateVolumeButton();
  });

  btnLiveEdge.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!state.isLive || btnLiveEdge.disabled) return;
    onSeekToTime(state.liveEdgeTime + LIVE_SEEK_LEAD_SECONDS);
  });

  progressWrap.addEventListener("keydown", (e) => {
    if (state.isLive && !state.liveDvrAvailable) return;
    let target = null;
    if (e.key === "ArrowLeft") target = state.currentTime - 5;
    if (e.key === "ArrowRight") target = state.currentTime + 5;
    if (e.key === "Home") target = state.isLive ? state.liveStartTime : 0;
    if (e.key === "End") target = state.isLive
      ? state.liveEdgeTime + LIVE_SEEK_LEAD_SECONDS
      : state.duration;
    if (target == null) return;
    e.preventDefault();
    onSeekToTime(Math.max(state.isLive ? state.liveStartTime : 0, target));
  });

  // Subtitle panel toggle
  btnSubs.addEventListener("click", (e) => {
    e.stopPropagation();
    audioPanel.classList.add("hidden");
    subsPanel.classList.toggle("hidden");
    showControls();
  });

  // Audio panel toggle
  btnAudio.addEventListener("click", (e) => {
    e.stopPropagation();
    subsPanel.classList.add("hidden");
    audioPanel.classList.toggle("hidden");
    showControls();
  });

  // Double-tap seek
  let lastTapTime = 0;
  let lastTapSide = null;
  let seekAccum = 0;
  let seekDisplayTimer = null;

  app.addEventListener("click", (e) => {
    if (!state.player) return;
    if (e.target.closest("button, #overlay, .browse-card, #subs-panel, #audio-panel")) return;
    const panelOpen = !subsPanel.classList.contains("hidden") || !audioPanel.classList.contains("hidden");
    if (panelOpen) {
      subsPanel.classList.add("hidden");
      audioPanel.classList.add("hidden");
      return;
    }
    if (e.target.closest("#controls-bottom")) return;

    const now = Date.now();
    const rect = app.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const side = xRatio < 0.33 ? "left" : xRatio > 0.67 ? "right" : null;

    const DOUBLE_TAP_MS = 500;
    const isDoubleTap = side && (now - lastTapTime) < DOUBLE_TAP_MS && side === lastTapSide;

    lastTapTime = now;
    lastTapSide = side;

    if (isDoubleTap) {
      seekAccum += 10;
      onSeekToTime(state.currentTime + (side === "right" ? 10 : -10));
      flashSeek(side, seekAccum);
      clearTimeout(seekDisplayTimer);
      seekDisplayTimer = setTimeout(() => { seekAccum = 0; }, 800);
    } else {
      seekAccum = 0;
      showControls();
    }
  });

  // Progress bar drag
  function getSeekFraction(e) {
    const rect = progressWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  progressWrap.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.isLive && !state.liveDvrAvailable) return;
    isDragging = true;
    progressWrap.classList.add("dragging");
    progressWrap.setPointerCapture(e.pointerId);
    const frac = getSeekFraction(e);
    updateProgress(frac);
    state.currentTime = state.isLive
      ? state.liveStartTime + frac * (state.liveEdgeTime - state.liveStartTime)
      : frac * state.duration;
    updateTimeDisplay();
  });

  progressWrap.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const frac = getSeekFraction(e);
    updateProgress(frac);
    state.currentTime = state.isLive
      ? state.liveStartTime + frac * (state.liveEdgeTime - state.liveStartTime)
      : frac * state.duration;
    updateTimeDisplay();
    showControls();
  });

  progressWrap.addEventListener("pointerup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    progressWrap.classList.remove("dragging");
    const fraction = getSeekFraction(e);
    onSeekToTime(state.isLive
      ? state.liveStartTime + fraction * (state.liveEdgeTime - state.liveStartTime)
      : fraction * state.duration);
  });

  progressWrap.addEventListener("pointercancel", () => {
    isDragging = false;
    progressWrap.classList.remove("dragging");
  });

}
