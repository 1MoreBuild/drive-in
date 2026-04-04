import { state } from "./state.js";
import { fmt } from "./utils.js";

// --- DOM elements ----------------------------------------------------

const app = document.getElementById("app");
const btnCenterPlay = document.getElementById("btn-center-play");
const btnVolume = document.getElementById("btn-volume");
const timeCurrent = document.getElementById("time-current");
const timeDuration = document.getElementById("time-duration");
const progressWrap = document.getElementById("progress-wrap");
const progressPlayed = document.getElementById("progress-played");
const progressScrubber = document.getElementById("progress-scrubber");
const seekIndicatorLeft = document.getElementById("seek-indicator-left");
const seekIndicatorRight = document.getElementById("seek-indicator-right");
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

export function updateTimeDisplay() {
  timeCurrent.textContent = fmt(state.currentTime);
  timeDuration.textContent = fmt(state.duration);
}

export function updateProgress(fraction) {
  const pct = `${(fraction * 100).toFixed(3)}%`;
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
    isDragging = true;
    progressWrap.classList.add("dragging");
    progressWrap.setPointerCapture(e.pointerId);
    const frac = getSeekFraction(e);
    updateProgress(frac);
    state.currentTime = frac * state.duration;
    updateTimeDisplay();
  });

  progressWrap.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const frac = getSeekFraction(e);
    updateProgress(frac);
    state.currentTime = frac * state.duration;
    updateTimeDisplay();
    showControls();
  });

  progressWrap.addEventListener("pointerup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    progressWrap.classList.remove("dragging");
    onSeekToTime(getSeekFraction(e) * state.duration);
  });

  progressWrap.addEventListener("pointercancel", () => {
    isDragging = false;
    progressWrap.classList.remove("dragging");
  });
}
