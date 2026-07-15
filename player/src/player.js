import { state } from "./state.js";
import {
  showControls, updateTimeDisplay, updateProgress, updatePlayButton,
  updateVolumeButton, showBuffering, hideBuffering, isDraggingProgress,
  mediaTitle,
} from "./controls.js";
import { renderSubtitle, loadSubtitleTrack, disableExternalSubtitle } from "./subtitles.js";
import { navigate } from "./router.js";
import { MediabunnyPlayer } from "./engine/mediabunny-player.js";
import { PageMemoryMonitor } from "./telemetry/page-memory-monitor.js";

// --- Callbacks (set by main.js to avoid circular deps) ---------------

let onUpdateSubsUI = () => {};
let onUpdateAudioUI = () => {};

export function setPlayerCallbacks({ updateSubsUI, updateAudioUI }) {
  onUpdateSubsUI = updateSubsUI;
  onUpdateAudioUI = updateAudioUI;
}

let lastUiPaintAt = 0;

const UI_PAINT_INTERVAL_MS = 250;
const DEFAULT_AUDIO_GAIN = 12.0;
const MIN_AUDIO_GAIN = 1.0;
const MAX_AUDIO_GAIN = 10.0;
const CAPABILITY_PROFILE = detectCapabilityProfile();
const PROGRESS_REPORT_INTERVAL_MS = 10_000;
const DECODE_HEALTH_INTERVAL_MS = 60_000;
const DECODE_JANK_RECHECK_COOLDOWN_MS = 15_000;
const STUTTER_EVENT_CAPACITY = 100;
const STUTTER_REPORT_INTERVAL_MS = 30_000;
const STUTTER_JANK_THRESHOLD_MS = 2000;
const STUTTER_LONG_TASK_THRESHOLD_MS = 50;
const STUTTER_MEMORY_SAMPLE_INTERVAL_MS = 15_000;
const STUTTER_AUDIO_SAMPLE_INTERVAL_MS = 1_000;
const STUTTER_FLUSH_IDLE_TIMEOUT_MS = 1_000;
const PLAYER_HEALTH_HEARTBEAT_INTERVAL_MS = 30_000;
const PLAYER_RECOVERY_MAX_ATTEMPTS = 2;
const PLAYER_RECOVERY_STABLE_MS = 60_000;
const PLAYER_RECOVERY_BACKOFF_MS = [1_000, 3_000];
const VIDEO_FREEZE_THRESHOLD_MS = 8_000;
const VIDEO_FREEZE_DRIFT_MS = 5_000;
const PLAYER_LOG_ENDPOINT = "/api/dev/player-log";
const SLOW_SEGMENT_FETCH_MS = 3_000;
const PLAYBACK_RATE_DROP_COOLDOWN_MS = 5_000;
const AUDIO_UNDERRUN_COOLDOWN_MS = 2_000;
const MEMORY_PRESSURE_GROWTH_BYTES = 8 * 1024 * 1024;
const MEMORY_PRESSURE_GROWTH_RATIO = 0.15;
const PAGE_MEMORY_SAMPLE_INTERVAL_MS = 5 * 60_000;
const playerMetricsState = createPlayerMetricsState();
const stutterEventBuffer = Array.from({ length: STUTTER_EVENT_CAPACITY }, () => ({
  seq: 0,
  type: "",
  timestamp: 0,
  playbackPosition: 0,
  durationMs: 0,
  expectedDeltaMs: 0,
  actualDeltaMs: 0,
  effectiveRate: 0,
  stallStartedAt: 0,
  underrunCount: 0,
  bufferedAudioMs: 0,
  usedJSHeapSize: 0,
  totalJSHeapSize: 0,
  jsHeapSizeLimit: 0,
  heapGrowthBytes: 0,
}));
const stutterTelemetryState = createStutterTelemetryState();
const decodeHealthState = createDecodeHealthState();
const playerRuntimeLogState = createPlayerRuntimeLogState();
let stutterReportInterval = null;
let stutterFlushTimer = null;
let stutterFlushIdleHandle = null;
let scheduledStutterFlushReason = "interval";
let longTaskObserver = null;
let decodeHealthInterval = null;
let playerHealthHeartbeatInterval = null;
const playbackRecoveryState = {
  attempts: 0,
  retryTimer: null,
  stableTimer: null,
  request: null,
};
const originalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
const pageMemoryMonitor = new PageMemoryMonitor({ intervalMs: PAGE_MEMORY_SAMPLE_INTERVAL_MS });
let pageMemoryCapabilityLogged = false;
let lastPageMemoryError = null;
let lastPageMemorySessionId = null;
let lastPageMemoryCorrelationValid = false;
let playbackSessionSequence = 0;

function getMediabunnyFaultInjection() {
  const params = new URLSearchParams(location.search);
  const durationMs = Number(params.get("videoStallMs"));
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const atSeconds = Number(params.get("videoStallAt"));
  return {
    durationMs,
    atSeconds: Number.isFinite(atSeconds) && atSeconds >= 0 ? atSeconds : 10,
  };
}

function defaultDecodePath() {
  return CAPABILITY_PROFILE.hasVideoDecoder
    ? "prefer-webcodecs-hardware"
    : CAPABILITY_PROFILE.hasWebCodecs
      ? "prefer-webcodecs"
      : "webcodecs-unavailable";
}

function clampAudioGain(value) {
  if (!Number.isFinite(value)) return DEFAULT_AUDIO_GAIN;
  return Math.min(MAX_AUDIO_GAIN, Math.max(MIN_AUDIO_GAIN, value));
}

function persistAudioGain() {}

function createPlayerMetricsState() {
  return {
    stallCount: 0,
    totalStallDurationMs: 0,
    stallStartedAt: 0,
    decodePath: defaultDecodePath(),
    lastVideoCurrentTimeMs: 0,
    lastVideoProgressAt: 0,
    freezeRecoveryTriggered: false,
  };
}

function clearPlaybackRecoveryTimers() {
  if (playbackRecoveryState.retryTimer) {
    clearTimeout(playbackRecoveryState.retryTimer);
    playbackRecoveryState.retryTimer = null;
  }
  if (playbackRecoveryState.stableTimer) {
    clearTimeout(playbackRecoveryState.stableTimer);
    playbackRecoveryState.stableTimer = null;
  }
}

function resetPlaybackRecovery({ clearRequest = false } = {}) {
  clearPlaybackRecoveryTimers();
  playbackRecoveryState.attempts = 0;
  if (clearRequest) playbackRecoveryState.request = null;
}

function getPlaybackRecoveryPosition(player) {
  const stats = summarizePlayerStats(player);
  const videoSeconds = stats?.videoCurrentTimeMs != null ? stats.videoCurrentTimeMs / 1000 : null;
  if (Number.isFinite(videoSeconds) && videoSeconds > 0) {
    return Math.max(0, Math.min(state.duration || Infinity, state.currentTime || videoSeconds, videoSeconds));
  }
  return Math.max(0, Math.min(state.duration || Infinity, state.currentTime || 0));
}

function isRecoverablePlaybackError(error) {
  const message = error?.message || String(error || "");
  return /demux error|decod|encodingerror|network|fetch|timeout|connection|video.*(stall|frozen)|stream.*(closed|ended)/i.test(message);
}

function markPlaybackStable(player) {
  if (playbackRecoveryState.stableTimer) clearTimeout(playbackRecoveryState.stableTimer);
  playbackRecoveryState.stableTimer = setTimeout(() => {
    playbackRecoveryState.stableTimer = null;
    if (state.player !== player || !state.isPlaying) return;
    playbackRecoveryState.attempts = 0;
    postPlayerRuntimeLog("playback_recovery_stable", {
      currentTime: state.currentTime,
    });
  }, PLAYER_RECOVERY_STABLE_MS);
}

function schedulePlaybackRecovery(player, error) {
  if (state.player !== player || !playbackRecoveryState.request || !isRecoverablePlaybackError(error)) {
    return false;
  }
  if (playbackRecoveryState.retryTimer) return true;
  if (playbackRecoveryState.attempts >= PLAYER_RECOVERY_MAX_ATTEMPTS) {
    state.isPlaying = false;
    showStatus("Video stream failed. Reload to try again.");
    postPlayerRuntimeLog("playback_recovery_exhausted", {
      error: error?.message || String(error),
      attempts: playbackRecoveryState.attempts,
    });
    return false;
  }

  if (playbackRecoveryState.stableTimer) {
    clearTimeout(playbackRecoveryState.stableTimer);
    playbackRecoveryState.stableTimer = null;
  }
  const attempt = playbackRecoveryState.attempts + 1;
  const delayMs = PLAYER_RECOVERY_BACKOFF_MS[Math.min(attempt - 1, PLAYER_RECOVERY_BACKOFF_MS.length - 1)];
  const startTime = getPlaybackRecoveryPosition(player);
  playbackRecoveryState.attempts = attempt;
  state.isPlaying = false;
  player.pause?.().catch(() => {});
  showStatus(`Recovering video (${attempt}/${PLAYER_RECOVERY_MAX_ATTEMPTS})...`);
  postPlayerRuntimeLog("playback_recovery_scheduled", {
    error: error?.message || String(error),
    attempt,
    delayMs,
    startTime,
  });

  const runRecovery = async () => {
    playbackRecoveryState.retryTimer = null;
    if (state.player !== player) return;
    if (state.playLock) {
      playbackRecoveryState.retryTimer = setTimeout(runRecovery, 500);
      return;
    }
    const request = playbackRecoveryState.request;
    if (!request) return;
    await play(request.url, request.title, {
      ...request.meta,
      startTime,
      __recovery: true,
    });
  };
  playbackRecoveryState.retryTimer = setTimeout(runRecovery, delayMs);
  return true;
}

function createStutterTelemetryState() {
  return {
    nextSeq: 1,
    writeIndex: 0,
    lastReportedSeq: 0,
    playbackStartedAt: 0,
    reportInFlight: false,
    reportQueued: false,
    queuedReason: "interval",
    lastTimeCallbackAt: 0,
    lastTimePtsMs: 0,
    lastExpectedDeltaMs: 33.333,
    lastAudioSampleAt: 0,
    lastAudioUnderrunCount: null,
    lastAudioUnderrunEventAt: 0,
    lastMemorySampleAt: 0,
    memoryBaselineUsedJSHeapSize: 0,
    lastRateDropLoggedAt: 0,
    pendingStallStartedAt: 0,
    pendingStallPerfAt: 0,
    pendingStallPlaybackPosition: 0,
    memorySnapshot: {
      timestamp: 0,
      usedJSHeapSize: 0,
      totalJSHeapSize: 0,
      jsHeapSizeLimit: 0,
      heapGrowthBytes: 0,
    },
  };
}

function createDecodeHealthState() {
  return {
    lastJankReportAt: 0,
  };
}

function createPlayerRuntimeLogState() {
  return {
    playbackSessionId: 0,
    frameCount: 0,
    jankCount: 0,
    lastHeartbeatFrameCount: 0,
    lastHeartbeatJankCount: 0,
    lastDecodePath: null,
    networkTimingInstalled: false,
    observedResourceKeys: new Set(),
  };
}

function resetPlayerMetrics() {
  playerMetricsState.stallCount = 0;
  playerMetricsState.totalStallDurationMs = 0;
  playerMetricsState.stallStartedAt = 0;
  playerMetricsState.decodePath = defaultDecodePath();
  playerMetricsState.lastVideoCurrentTimeMs = 0;
  playerMetricsState.lastVideoProgressAt = 0;
  playerMetricsState.freezeRecoveryTriggered = false;
}

function resetStutterTelemetry() {
  stutterTelemetryState.lastReportedSeq = stutterTelemetryState.nextSeq - 1;
  stutterTelemetryState.playbackStartedAt = performance.now();
  stutterTelemetryState.reportInFlight = false;
  stutterTelemetryState.reportQueued = false;
  stutterTelemetryState.queuedReason = "interval";
  stutterTelemetryState.lastTimeCallbackAt = 0;
  stutterTelemetryState.lastTimePtsMs = 0;
  stutterTelemetryState.lastExpectedDeltaMs = 33.333;
  stutterTelemetryState.lastAudioSampleAt = 0;
  stutterTelemetryState.lastAudioUnderrunCount = null;
  stutterTelemetryState.lastAudioUnderrunEventAt = 0;
  stutterTelemetryState.lastMemorySampleAt = 0;
  stutterTelemetryState.memoryBaselineUsedJSHeapSize = 0;
  stutterTelemetryState.lastRateDropLoggedAt = 0;
  stutterTelemetryState.pendingStallStartedAt = 0;
  stutterTelemetryState.pendingStallPerfAt = 0;
  stutterTelemetryState.pendingStallPlaybackPosition = 0;
  stutterTelemetryState.memorySnapshot.timestamp = 0;
  stutterTelemetryState.memorySnapshot.usedJSHeapSize = 0;
  stutterTelemetryState.memorySnapshot.totalJSHeapSize = 0;
  stutterTelemetryState.memorySnapshot.jsHeapSizeLimit = 0;
  stutterTelemetryState.memorySnapshot.heapGrowthBytes = 0;
}

function resetDecodeHealthState() {
  decodeHealthState.lastJankReportAt = 0;
}

function resetPlayerRuntimeLogState() {
  playerRuntimeLogState.frameCount = 0;
  playerRuntimeLogState.jankCount = 0;
  playerRuntimeLogState.lastHeartbeatFrameCount = 0;
  playerRuntimeLogState.lastHeartbeatJankCount = 0;
  playerRuntimeLogState.lastDecodePath = null;
}

function recordStutterEvent(type, fields = {}) {
  const slot = stutterEventBuffer[stutterTelemetryState.writeIndex];
  slot.seq = stutterTelemetryState.nextSeq++;
  slot.type = type;
  slot.timestamp = fields.timestamp ?? Date.now();
  slot.playbackPosition = fields.playbackPosition ?? state.currentTime ?? 0;
  slot.durationMs = fields.durationMs ?? 0;
  slot.expectedDeltaMs = fields.expectedDeltaMs ?? 0;
  slot.actualDeltaMs = fields.actualDeltaMs ?? 0;
  slot.effectiveRate = fields.effectiveRate ?? 0;
  slot.stallStartedAt = fields.stallStartedAt ?? 0;
  slot.underrunCount = fields.underrunCount ?? 0;
  slot.bufferedAudioMs = fields.bufferedAudioMs ?? 0;
  slot.usedJSHeapSize = fields.usedJSHeapSize ?? 0;
  slot.totalJSHeapSize = fields.totalJSHeapSize ?? 0;
  slot.jsHeapSizeLimit = fields.jsHeapSizeLimit ?? 0;
  slot.heapGrowthBytes = fields.heapGrowthBytes ?? 0;
  stutterTelemetryState.writeIndex = (stutterTelemetryState.writeIndex + 1) % STUTTER_EVENT_CAPACITY;
}

function beginStall() {
  if (playerMetricsState.stallStartedAt) return;
  playerMetricsState.stallCount += 1;
  playerMetricsState.stallStartedAt = performance.now();
  postPlayerRuntimeLog("stall_start", {
    buffer: collectBufferState(),
    memory: memorySnapshotForLog(false),
  });
  if (!stutterTelemetryState.pendingStallStartedAt) {
    stutterTelemetryState.pendingStallStartedAt = Date.now();
    stutterTelemetryState.pendingStallPerfAt = performance.now();
    stutterTelemetryState.pendingStallPlaybackPosition = state.currentTime;
  }
}

function endStall() {
  if (!playerMetricsState.stallStartedAt) return;
  const stallDurationMs = performance.now() - playerMetricsState.stallStartedAt;
  playerMetricsState.totalStallDurationMs += stallDurationMs;
  playerMetricsState.stallStartedAt = 0;
  postPlayerRuntimeLog("stall_end", {
    durationMs: Math.round(stallDurationMs),
    buffer: collectBufferState(),
    memory: memorySnapshotForLog(false),
  });
  if (stutterTelemetryState.pendingStallStartedAt) {
    recordStutterEvent("buffering_stall", {
      playbackPosition: stutterTelemetryState.pendingStallPlaybackPosition,
      stallStartedAt: stutterTelemetryState.pendingStallStartedAt,
      durationMs: stallDurationMs,
    });
    stutterTelemetryState.pendingStallStartedAt = 0;
    stutterTelemetryState.pendingStallPerfAt = 0;
    stutterTelemetryState.pendingStallPlaybackPosition = 0;
    queueStutterTelemetryReport("stall");
  }
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
    if ("hlsBufferedAheadSeconds" in value) {
      const seconds = normalizeMetricNumber(value.hlsBufferedAheadSeconds);
      return seconds == null ? null : Math.max(0, seconds);
    }
    if ("videoBufferedMs" in value) {
      const milliseconds = normalizeMetricNumber(value.videoBufferedMs);
      if (milliseconds != null) return Math.max(0, milliseconds / 1000);
    }
    for (const key of ["bufferHealthSeconds", "bufferedSeconds", "bufferedDuration", "seconds"]) {
      if (!(key in value)) continue;
      const seconds = normalizeMetricNumber(value[key]);
      return seconds == null ? null : Math.max(0, seconds);
    }
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
    for (const key of ["videoFrameDropCount", "droppedFrames", "droppedVideoFrames", "dropped", "droppedCount"]) {
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

function inferExpectedFrameDeltaMs(ptsDeltaMs) {
  if (Number.isFinite(ptsDeltaMs) && ptsDeltaMs > 0) {
    if (ptsDeltaMs <= 25) return 16.667;
    if (ptsDeltaMs <= 45) return 33.333;
  }
  return stutterTelemetryState.lastExpectedDeltaMs || 33.333;
}

function normalizeDurationMs(value) {
  if (typeof value === "bigint") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value > 120) return value;
  return value * 1000;
}

function normalizeAudioBufferedMs(value) {
  if (value == null) return null;

  if (typeof value === "number" || typeof value === "bigint") {
    return normalizeDurationMs(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const bufferedAudioMs = normalizeAudioBufferedMs(item);
      if (bufferedAudioMs != null) return bufferedAudioMs;
    }
    return null;
  }

  if (typeof value === "object") {
    if ("audio" in value) {
      const nestedBufferedAudioMs = normalizeAudioBufferedMs(value.audio);
      if (nestedBufferedAudioMs != null) return nestedBufferedAudioMs;
    }
    for (const key of [
      "audioBufferMs",
      "audioBufferedMs",
      "audioBufferDurationMs",
      "audioBufferSeconds",
      "audioBufferedSeconds",
      "audioBufferHealthSeconds",
      "bufferedAudioSeconds",
      "bufferedAudioMs",
      "bufferHealthSeconds",
    ]) {
      if (key in value) {
        const bufferedAudioMs = normalizeAudioBufferedMs(value[key]);
        if (bufferedAudioMs != null) return bufferedAudioMs;
      }
    }
  }

  return null;
}

function normalizeUnderrunCount(value) {
  if (typeof value === "bigint") value = Number(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "object" && value) {
    if ("audio" in value) {
      const nestedUnderrunCount = normalizeUnderrunCount(value.audio);
      if (nestedUnderrunCount != null) return nestedUnderrunCount;
    }
    for (const key of [
      "audioStutter",
      "audioUnderrunCount",
      "audioUnderflowCount",
      "underrunCount",
      "underflowCount",
      "underruns",
      "underflows",
    ]) {
      if (key in value) {
        const underrunCount = normalizeUnderrunCount(value[key]);
        if (underrunCount != null) return underrunCount;
      }
    }
  }
  return null;
}

function readAudioBufferStats(player) {
  const readers = [
    () => player?.getAudioStats?.(),
    () => player?.getStats?.(),
    () => player?.AudioPipelineProxy?.AudioRenderPipeline?.getStats?.(),
    () => player?.audio?.getStats?.(),
  ];

  let bufferedAudioMs = null;
  let underrunCount = null;

  for (const read of readers) {
    let stats;
    try {
      stats = read();
    } catch {
      continue;
    }
    if (stats == null) continue;

    if (bufferedAudioMs == null) bufferedAudioMs = normalizeAudioBufferedMs(stats);
    if (underrunCount == null) underrunCount = normalizeUnderrunCount(stats);
    if (bufferedAudioMs != null && underrunCount != null) break;
  }

  return { bufferedAudioMs, underrunCount };
}

function memorySnapshotForLog(force = true) {
  const snapshot = sampleMemoryUsage(performance.now(), force);
  const pageMemory = pageMemoryMonitor.lastSample;
  if (!snapshot && !pageMemory && !pageMemoryMonitor.supported) {
    return {
      pageMemorySupported: false,
      pageMemoryUnavailableReason: pageMemoryMonitor.unavailableReason,
    };
  }
  return {
    timestamp: snapshot?.timestamp ?? null,
    usedJSHeapSize: snapshot?.usedJSHeapSize ?? null,
    totalJSHeapSize: snapshot?.totalJSHeapSize ?? null,
    jsHeapSizeLimit: snapshot?.jsHeapSizeLimit ?? null,
    heapGrowthBytes: snapshot?.heapGrowthBytes ?? null,
    pageMemorySupported: pageMemoryMonitor.supported,
    pageMemoryBytes: pageMemory?.bytes ?? null,
    pageMemoryMeasuredAt: pageMemory?.timestamp ?? null,
    pageMemorySampleAgeMs: pageMemory ? Math.max(0, Date.now() - pageMemory.timestamp) : null,
    pageMemoryMeasurementDurationMs: pageMemory?.durationMs ?? null,
    pageMemoryPlaybackSessionId: lastPageMemorySessionId,
    pageMemoryCorrelationValid: pageMemory
      ? lastPageMemoryCorrelationValid
        && lastPageMemorySessionId === playerRuntimeLogState.playbackSessionId
      : null,
  };
}

function collectBufferState(player = state.player) {
  const { bufferedAudioMs, underrunCount } = readAudioBufferStats(player);
  const stats = readPlayerStats(player);
  return {
    bufferHealthSeconds: readBufferHealthSeconds(player),
    bufferedAudioMs,
    audioUnderrunCount: underrunCount,
    hlsBufferedAheadSeconds: normalizeMetricNumber(stats?.hlsBufferedAheadSeconds),
    hlsBufferedBytes: normalizeMetricNumber(stats?.hlsBufferedBytes),
    hlsCachedSegments: normalizeMetricNumber(stats?.hlsCachedSegments),
    hlsPendingSegments: normalizeMetricNumber(stats?.hlsPendingSegments),
    hlsBufferMaxBytes: normalizeMetricNumber(stats?.hlsBufferMaxBytes),
    hlsBufferTargetSeconds: normalizeMetricNumber(stats?.hlsBufferTargetSeconds),
    hlsBufferCacheUtilization: safeRound(normalizeMetricNumber(stats?.hlsBufferCacheUtilization)),
    hlsPeakBufferedBytes: normalizeMetricNumber(stats?.hlsPeakBufferedBytes),
    hlsPeakBufferedAheadSeconds: normalizeMetricNumber(stats?.hlsPeakBufferedAheadSeconds),
    hlsManagedBytesEstimate: normalizeMetricNumber(stats?.hlsManagedBytesEstimate),
    hlsPeakManagedBytesEstimate: normalizeMetricNumber(stats?.hlsPeakManagedBytesEstimate),
    hlsBufferByteCapHitCount: normalizeMetricNumber(stats?.hlsBufferByteCapHitCount),
  };
}

async function maybeMeasurePageMemory() {
  if (!pageMemoryMonitor.supported) {
    if (!pageMemoryCapabilityLogged) {
      pageMemoryCapabilityLogged = true;
      postPlayerRuntimeLog("page_memory_measurement_unavailable", {
        reason: pageMemoryMonitor.unavailableReason,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
      });
    }
    return;
  }

  const measurementSessionId = playerRuntimeLogState.playbackSessionId;
  const measurementPlayer = state.player;
  try {
    const sample = await pageMemoryMonitor.measure();
    if (!sample) return;
    const correlationValid = measurementSessionId === playerRuntimeLogState.playbackSessionId
      && measurementPlayer === state.player;
    lastPageMemorySessionId = measurementSessionId;
    lastPageMemoryCorrelationValid = correlationValid;
    if (!correlationValid) pageMemoryMonitor.allowNextMeasurement();
    lastPageMemoryError = null;
    postPlayerRuntimeLog("page_memory_measurement", {
      measurementPlaybackSessionId: measurementSessionId,
      correlationValid,
      memory: sample,
      buffer: correlationValid ? collectBufferState(measurementPlayer) : null,
      playerStats: correlationValid ? summarizePlayerStats(measurementPlayer) : null,
      totalStallCount: correlationValid ? playerMetricsState.stallCount : null,
      totalStallDurationMs: correlationValid ? Math.round(playerMetricsState.totalStallDurationMs) : null,
    });
  } catch (error) {
    const message = error?.message || String(error);
    if (message === lastPageMemoryError) return;
    lastPageMemoryError = message;
    postPlayerRuntimeLog("page_memory_measurement_failed", {
      error: message,
      measurementPlaybackSessionId: measurementSessionId,
    });
  }
}

function postPlayerRuntimeLog(type, fields = {}) {
  if (!originalFetch) return;
  const payload = {
    type,
    timestamp: Date.now(),
    playbackPosition: Number((state.currentTime || 0).toFixed(3)),
    playbackState: getPlaybackState(),
    duration: state.duration || 0,
    isPlaying: !!state.isPlaying,
    isBuffering: !!state.isBuffering,
    playbackSessionId: playerRuntimeLogState.playbackSessionId,
    ...fields,
  };
  originalFetch(PLAYER_LOG_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function isPlayerMediaResourceUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url, location.origin);
    const path = parsed.pathname;
    return path.startsWith("/api/proxy")
      || path.startsWith("/api/dash")
      || path.startsWith("/api/plex/dash")
      || /\.(m4s|mp4|m3u8|mpd|ts)(\?|$)/i.test(`${path}${parsed.search}`);
  } catch {
    return false;
  }
}

function logSlowPlayerFetch(url, durationMs, fields = {}) {
  if (durationMs <= SLOW_SEGMENT_FETCH_MS || !isPlayerMediaResourceUrl(url)) return;
  postPlayerRuntimeLog("network_segment_slow", {
    url,
    durationMs: Math.round(durationMs),
    ...fields,
  });
}

function installPlayerNetworkTiming() {
  if (playerRuntimeLogState.networkTimingInstalled || !originalFetch) return;
  playerRuntimeLogState.networkTimingInstalled = true;

  globalThis.fetch = async (...args) => {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    const startedAt = performance.now();
    try {
      const response = await originalFetch(...args);
      logSlowPlayerFetch(url, performance.now() - startedAt, {
        observer: "fetch",
        status: response.status,
        contentLength: Number(response.headers?.get?.("content-length")) || null,
      });
      return response;
    } catch (error) {
      if (isPlayerMediaResourceUrl(url)) {
        postPlayerRuntimeLog("network_segment_fetch_error", {
          url,
          durationMs: Math.round(performance.now() - startedAt),
          error: error.message || String(error),
        });
      }
      throw error;
    }
  };

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!isPlayerMediaResourceUrl(entry.name) || entry.duration <= SLOW_SEGMENT_FETCH_MS) continue;
        const key = `${entry.name}:${entry.startTime}`;
        if (playerRuntimeLogState.observedResourceKeys.has(key)) continue;
        playerRuntimeLogState.observedResourceKeys.add(key);
        if (playerRuntimeLogState.observedResourceKeys.size > 500) {
          playerRuntimeLogState.observedResourceKeys.clear();
        }
        postPlayerRuntimeLog("network_segment_slow", {
          observer: "performance-resource",
          url: entry.name,
          durationMs: Math.round(entry.duration),
          transferSize: entry.transferSize || 0,
          encodedBodySize: entry.encodedBodySize || 0,
          decodedBodySize: entry.decodedBodySize || 0,
        });
      }
    });
    try {
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer.observe({ entryTypes: ["resource"] });
    }
  } catch {}
}

installPlayerNetworkTiming();

function normalizeMetricNumber(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function safeRound(value, digits = 3) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function readPlayerStats(player) {
  try {
    const stats = player?.getStats?.();
    return stats && typeof stats === "object" ? stats : null;
  } catch {
    return null;
  }
}

function summarizePlayerStats(player) {
  const stats = readPlayerStats(player);
  if (!stats) return null;

  const jitterBuffer = stats.jitterBuffer && typeof stats.jitterBuffer === "object"
    ? {
        minMs: normalizeMetricNumber(stats.jitterBuffer.min),
        maxMs: normalizeMetricNumber(stats.jitterBuffer.max),
      }
    : null;

  return {
    audioPacketQueueLength: normalizeMetricNumber(stats.audioPacketQueueLength),
    audioDropPacketCount: normalizeMetricNumber(stats.audioDropPacketCount),
    audioFrameDecodeCount: normalizeMetricNumber(stats.audioFrameDecodeCount),
    audioFrameRenderCount: normalizeMetricNumber(stats.audioFrameRenderCount),
    audioFrameRenderIntervalMax: normalizeMetricNumber(stats.audioFrameRenderIntervalMax),
    videoPacketQueueLength: normalizeMetricNumber(stats.videoPacketQueueLength),
    videoDropPacketCount: normalizeMetricNumber(stats.videoDropPacketCount),
    videoDecodeErrorPacketCount: normalizeMetricNumber(stats.videoDecodeErrorPacketCount),
    videoFrameDecodeCount: normalizeMetricNumber(stats.videoFrameDecodeCount),
    videoFrameRenderCount: normalizeMetricNumber(stats.videoFrameRenderCount),
    videoFrameDropCount: normalizeMetricNumber(stats.videoFrameDropCount),
    videoFrameDecodeIntervalMax: normalizeMetricNumber(stats.videoFrameDecodeIntervalMax),
    videoFrameRenderIntervalMax: normalizeMetricNumber(stats.videoFrameRenderIntervalMax),
    bandwidth: normalizeMetricNumber(stats.bandwidth),
    jitter: safeRound(normalizeMetricNumber(stats.jitter)),
    bufferReceiveBytes: normalizeMetricNumber(stats.bufferReceiveBytes),
    bufferOutputBytes: normalizeMetricNumber(stats.bufferOutputBytes),
    bufferDropBytes: normalizeMetricNumber(stats.bufferDropBytes),
    audioStutter: normalizeMetricNumber(stats.audioStutter),
    videoStutter: normalizeMetricNumber(stats.videoStutter),
    audioCurrentTimeMs: normalizeMetricNumber(stats.audioCurrentTime),
    videoCurrentTimeMs: normalizeMetricNumber(stats.videoCurrentTime),
    audioNextTimeMs: normalizeMetricNumber(stats.audioNextTime),
    videoNextTimeMs: normalizeMetricNumber(stats.videoNextTime),
    audioCodec: typeof stats.audiocodec === "string" ? stats.audiocodec : null,
    videoCodec: typeof stats.videocodec === "string" ? stats.videocodec : null,
    width: normalizeMetricNumber(stats.width),
    height: normalizeMetricNumber(stats.height),
    hlsBufferedAheadSeconds: normalizeMetricNumber(stats.hlsBufferedAheadSeconds),
    hlsBufferedBytes: normalizeMetricNumber(stats.hlsBufferedBytes),
    hlsCachedSegments: normalizeMetricNumber(stats.hlsCachedSegments),
    hlsPendingSegments: normalizeMetricNumber(stats.hlsPendingSegments),
    hlsBufferMaxBytes: normalizeMetricNumber(stats.hlsBufferMaxBytes),
    hlsBufferTargetSeconds: normalizeMetricNumber(stats.hlsBufferTargetSeconds),
    hlsBufferCacheUtilization: safeRound(normalizeMetricNumber(stats.hlsBufferCacheUtilization)),
    hlsPeakBufferedBytes: normalizeMetricNumber(stats.hlsPeakBufferedBytes),
    hlsPeakBufferedAheadSeconds: normalizeMetricNumber(stats.hlsPeakBufferedAheadSeconds),
    hlsManagedBytesEstimate: normalizeMetricNumber(stats.hlsManagedBytesEstimate),
    hlsPeakManagedBytesEstimate: normalizeMetricNumber(stats.hlsPeakManagedBytesEstimate),
    hlsBufferByteCapHitCount: normalizeMetricNumber(stats.hlsBufferByteCapHitCount),
    abrCurrentBitrate: normalizeMetricNumber(stats.abrCurrentBitrate),
    abrAdvertisedBitrate: normalizeMetricNumber(stats.abrAdvertisedBitrate),
    abrLastDecision: stats.abrLastDecision && typeof stats.abrLastDecision === "object"
      ? stats.abrLastDecision
      : null,
    jitterBuffer,
  };
}

function describePlayerCanvas() {
  const canvas = container?.querySelector?.("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return null;

  return {
    width: canvas.width,
    height: canvas.height,
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
  };
}

function sampleMemoryUsage(now = performance.now(), force = false) {
  if (!force && now - stutterTelemetryState.lastMemorySampleAt < STUTTER_MEMORY_SAMPLE_INTERVAL_MS) {
    return stutterTelemetryState.memorySnapshot.timestamp ? stutterTelemetryState.memorySnapshot : null;
  }

  const memory = performance?.memory;
  stutterTelemetryState.lastMemorySampleAt = now;
  if (!memory) return null;

  const usedJSHeapSize = Number(memory.usedJSHeapSize) || 0;
  const totalJSHeapSize = Number(memory.totalJSHeapSize) || 0;
  const jsHeapSizeLimit = Number(memory.jsHeapSizeLimit) || 0;
  const previousBaseline = stutterTelemetryState.memoryBaselineUsedJSHeapSize;
  const heapGrowthBytes = previousBaseline > 0 ? usedJSHeapSize - previousBaseline : 0;
  const snapshot = stutterTelemetryState.memorySnapshot;

  snapshot.timestamp = Date.now();
  snapshot.usedJSHeapSize = usedJSHeapSize;
  snapshot.totalJSHeapSize = totalJSHeapSize;
  snapshot.jsHeapSizeLimit = jsHeapSizeLimit;
  snapshot.heapGrowthBytes = heapGrowthBytes;

  if (!previousBaseline || usedJSHeapSize < previousBaseline * 0.9) {
    stutterTelemetryState.memoryBaselineUsedJSHeapSize = usedJSHeapSize;
  } else if (
    heapGrowthBytes >= MEMORY_PRESSURE_GROWTH_BYTES
    && heapGrowthBytes / Math.max(previousBaseline, 1) >= MEMORY_PRESSURE_GROWTH_RATIO
  ) {
    recordStutterEvent("memory_pressure", {
      usedJSHeapSize,
      totalJSHeapSize,
      jsHeapSizeLimit,
      heapGrowthBytes,
    });
    stutterTelemetryState.memoryBaselineUsedJSHeapSize = usedJSHeapSize;
  }

  return snapshot;
}

function sampleAudioUnderruns(player, now = performance.now()) {
  if (!player || now - stutterTelemetryState.lastAudioSampleAt < STUTTER_AUDIO_SAMPLE_INTERVAL_MS) return;
  stutterTelemetryState.lastAudioSampleAt = now;

  const { bufferedAudioMs, underrunCount } = readAudioBufferStats(player);
  if (underrunCount != null) {
    const lastUnderrunCount = stutterTelemetryState.lastAudioUnderrunCount;
    if (lastUnderrunCount == null && underrunCount > 0) {
      recordStutterEvent("audio_underrun", {
        underrunCount,
        bufferedAudioMs: bufferedAudioMs ?? 0,
      });
    } else if (lastUnderrunCount != null && underrunCount > lastUnderrunCount) {
      recordStutterEvent("audio_underrun", {
        underrunCount: underrunCount - lastUnderrunCount,
        bufferedAudioMs: bufferedAudioMs ?? 0,
      });
    }
    stutterTelemetryState.lastAudioUnderrunCount = underrunCount;
    return;
  }

  if (
    bufferedAudioMs != null
    && bufferedAudioMs <= 0
    && state.isPlaying
    && !state.isBuffering
    && now - stutterTelemetryState.lastAudioUnderrunEventAt >= AUDIO_UNDERRUN_COOLDOWN_MS
  ) {
    stutterTelemetryState.lastAudioUnderrunEventAt = now;
    recordStutterEvent("audio_underrun", {
      bufferedAudioMs: 0,
      underrunCount: 1,
    });
  }
}

function serializeStutterEvent(slot) {
  const event = {
    type: slot.type,
    timestamp: slot.timestamp,
    playbackPosition: Number(slot.playbackPosition.toFixed(3)),
  };

  if (slot.type === "frame_jank") {
    event.expectedDeltaMs = Math.round(slot.expectedDeltaMs);
    event.actualDeltaMs = Math.round(slot.actualDeltaMs);
  }
  if (slot.type === "buffering_stall") {
    event.startTime = slot.stallStartedAt;
    event.durationMs = Math.round(slot.durationMs);
  }
  if (slot.type === "audio_underrun") {
    event.underrunCount = slot.underrunCount;
    event.bufferedAudioMs = Math.round(slot.bufferedAudioMs);
  }
  if (slot.type === "memory_pressure") {
    event.usedJSHeapSize = slot.usedJSHeapSize;
    event.totalJSHeapSize = slot.totalJSHeapSize;
    event.jsHeapSizeLimit = slot.jsHeapSizeLimit;
    event.heapGrowthBytes = slot.heapGrowthBytes;
  }
  if (slot.type === "playback_rate_drop") {
    event.effectiveRate = Number(slot.effectiveRate.toFixed(3));
    event.actualDeltaMs = Math.round(slot.actualDeltaMs);
  }
  if (slot.type === "long_task") {
    event.durationMs = Math.round(slot.durationMs);
  }

  return event;
}

function collectStutterEventsSinceLastReport() {
  const pending = [];
  let maxSeq = stutterTelemetryState.lastReportedSeq;

  for (const slot of stutterEventBuffer) {
    if (!slot.seq || slot.seq <= stutterTelemetryState.lastReportedSeq) continue;
    pending.push(slot);
    if (slot.seq > maxSeq) maxSeq = slot.seq;
  }

  pending.sort((a, b) => a.seq - b.seq);

  return {
    events: pending.map(serializeStutterEvent),
    maxSeq,
  };
}

function buildStutterReportPayload(reason) {
  const memorySnapshot = memorySnapshotForLog(true);
  const { events, maxSeq } = collectStutterEventsSinceLastReport();
  const activeStallDurationMs = playerMetricsState.stallStartedAt
    ? performance.now() - playerMetricsState.stallStartedAt
    : 0;

  return {
    maxSeq,
    payload: {
      reason,
      events,
      currentTime: state.currentTime,
      duration: state.duration,
      memory: memorySnapshot,
      buffer: collectBufferState(),
      totalStallCount: playerMetricsState.stallCount,
      totalStallDurationMs: Math.round(playerMetricsState.totalStallDurationMs + activeStallDurationMs),
      timeSincePlaybackStartedMs: Math.round(Math.max(0, performance.now() - stutterTelemetryState.playbackStartedAt)),
    },
  };
}

function clearScheduledStutterTelemetryFlush() {
  if (stutterFlushTimer) {
    clearTimeout(stutterFlushTimer);
    stutterFlushTimer = null;
  }
  if (stutterFlushIdleHandle && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(stutterFlushIdleHandle);
  }
  if (stutterFlushIdleHandle) {
    stutterFlushIdleHandle = null;
  }
  scheduledStutterFlushReason = "interval";
}

function postStutterTelemetry(payload, keepalive = false) {
  const body = JSON.stringify(payload);
  if (keepalive && typeof navigator.sendBeacon === "function") {
    try {
      const sent = navigator.sendBeacon(
        "/api/dev/stutter-log",
        new Blob([body], { type: "application/json" }),
      );
      if (sent) return Promise.resolve(true);
    } catch {}
  }

  return fetch("/api/dev/stutter-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive,
  }).then((response) => response.ok);
}

function flushStutterTelemetry(reason = "interval", { keepalive = false } = {}) {
  if (!stutterTelemetryState.playbackStartedAt) return;
  if (stutterTelemetryState.reportInFlight) {
    stutterTelemetryState.reportQueued = true;
    stutterTelemetryState.queuedReason = reason;
    return;
  }

  const { payload, maxSeq } = buildStutterReportPayload(reason);
  if (payload.events.length === 0 && !playerMetricsState.stallStartedAt) return;

  stutterTelemetryState.reportInFlight = true;
  postStutterTelemetry(payload, keepalive).then((ok) => {
    if (ok) {
      stutterTelemetryState.lastReportedSeq = maxSeq;
    }
  }).catch(() => {
  }).finally(() => {
    stutterTelemetryState.reportInFlight = false;
    if (stutterTelemetryState.reportQueued) {
      const queuedReason = stutterTelemetryState.queuedReason;
      stutterTelemetryState.reportQueued = false;
      stutterTelemetryState.queuedReason = "interval";
      flushStutterTelemetry(queuedReason);
    }
  });
}

function queueStutterTelemetryReport(reason = "interval") {
  if (!stutterTelemetryState.playbackStartedAt) return;
  if (reason !== "interval" || scheduledStutterFlushReason === "interval") {
    scheduledStutterFlushReason = reason;
  }
  if (stutterFlushTimer || stutterFlushIdleHandle) return;

  const runFlush = () => {
    stutterFlushTimer = null;
    stutterFlushIdleHandle = null;
    const queuedReason = scheduledStutterFlushReason;
    scheduledStutterFlushReason = "interval";
    flushStutterTelemetry(queuedReason);
  };

  if (typeof requestIdleCallback === "function") {
    stutterFlushIdleHandle = requestIdleCallback(runFlush, { timeout: STUTTER_FLUSH_IDLE_TIMEOUT_MS });
    return;
  }

  stutterFlushTimer = setTimeout(runFlush, 0);
}

function startStutterTelemetryReporting() {
  stopStutterTelemetryReporting();
  stutterReportInterval = setInterval(() => {
    queueStutterTelemetryReport("interval");
  }, STUTTER_REPORT_INTERVAL_MS);
}

function stopStutterTelemetryReporting() {
  if (stutterReportInterval) {
    clearInterval(stutterReportInterval);
    stutterReportInterval = null;
  }
  clearScheduledStutterTelemetryFlush();
}

function sendPlayerHealthHeartbeat() {
  const frameCountSinceLastHeartbeat = playerRuntimeLogState.frameCount - playerRuntimeLogState.lastHeartbeatFrameCount;
  const jankCountSinceLastHeartbeat = playerRuntimeLogState.jankCount - playerRuntimeLogState.lastHeartbeatJankCount;
  playerRuntimeLogState.lastHeartbeatFrameCount = playerRuntimeLogState.frameCount;
  playerRuntimeLogState.lastHeartbeatJankCount = playerRuntimeLogState.jankCount;
  void maybeMeasurePageMemory();

  postPlayerRuntimeLog("health_heartbeat", {
    currentTime: state.currentTime,
    buffer: collectBufferState(),
    frameCountSinceLastHeartbeat,
    jankCountSinceLastHeartbeat,
    memory: memorySnapshotForLog(true),
    decodePath: playerMetricsState.decodePath,
    droppedFrames: readDroppedFrames(state.player),
  });
}

function startPlayerHealthHeartbeat() {
  stopPlayerHealthHeartbeat();
  playerRuntimeLogState.lastHeartbeatFrameCount = playerRuntimeLogState.frameCount;
  playerRuntimeLogState.lastHeartbeatJankCount = playerRuntimeLogState.jankCount;
  playerHealthHeartbeatInterval = setInterval(() => {
    sendPlayerHealthHeartbeat();
  }, PLAYER_HEALTH_HEARTBEAT_INTERVAL_MS);
}

function stopPlayerHealthHeartbeat() {
  if (playerHealthHeartbeatInterval) {
    clearInterval(playerHealthHeartbeatInterval);
    playerHealthHeartbeatInterval = null;
  }
}

function ensureLongTaskObserver() {
  if (longTaskObserver || typeof PerformanceObserver !== "function") return;
  const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
  if (Array.isArray(supportedEntryTypes) && !supportedEntryTypes.includes("longtask")) return;

  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (!stutterTelemetryState.playbackStartedAt) return;

      let recordedLongTask = false;
      for (const entry of list.getEntries()) {
        if (entry.duration < STUTTER_LONG_TASK_THRESHOLD_MS) continue;
        recordedLongTask = true;
        playerRuntimeLogState.jankCount += 1;
        recordStutterEvent("long_task", {
          timestamp: Math.round(performance.timeOrigin + entry.startTime),
          playbackPosition: state.currentTime,
          durationMs: entry.duration,
        });
      }

      if (recordedLongTask) {
        queueStutterTelemetryReport("longtask");
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserver = null;
  }
}

function detectVideoFreeze(playerStats) {
  const now = performance.now();
  const videoCurrentTimeMs = playerStats?.videoCurrentTimeMs;
  const audioCurrentTimeMs = playerStats?.audioCurrentTimeMs;
  const hasRenderedVideo = (playerStats?.videoFrameRenderCount || 0) > 0;

  if (!state.isPlaying || !hasRenderedVideo || !Number.isFinite(videoCurrentTimeMs)) {
    playerMetricsState.lastVideoCurrentTimeMs = videoCurrentTimeMs || 0;
    playerMetricsState.lastVideoProgressAt = now;
    playerMetricsState.freezeRecoveryTriggered = false;
    return;
  }

  if (videoCurrentTimeMs > playerMetricsState.lastVideoCurrentTimeMs + 50) {
    playerMetricsState.lastVideoCurrentTimeMs = videoCurrentTimeMs;
    playerMetricsState.lastVideoProgressAt = now;
    playerMetricsState.freezeRecoveryTriggered = false;
    return;
  }

  if (!playerMetricsState.lastVideoProgressAt) {
    playerMetricsState.lastVideoProgressAt = now;
    return;
  }

  const driftMs = Number.isFinite(audioCurrentTimeMs)
    ? audioCurrentTimeMs - videoCurrentTimeMs
    : 0;
  const frozenForMs = now - playerMetricsState.lastVideoProgressAt;
  if (
    driftMs >= VIDEO_FREEZE_DRIFT_MS
    && frozenForMs >= VIDEO_FREEZE_THRESHOLD_MS
    && !playerMetricsState.freezeRecoveryTriggered
  ) {
    playerMetricsState.freezeRecoveryTriggered = true;
    const error = new Error(`video stalled for ${Math.round(frozenForMs)}ms with ${Math.round(driftMs)}ms A/V drift`);
    postPlayerRuntimeLog("video_freeze_detected", {
      videoCurrentTimeMs,
      audioCurrentTimeMs,
      frozenForMs: Math.round(frozenForMs),
      driftMs: Math.round(driftMs),
    });
    schedulePlaybackRecovery(state.player, error);
  }
}

function reportPlayerMetrics() {
  const activeStallDurationMs = playerMetricsState.stallStartedAt
    ? performance.now() - playerMetricsState.stallStartedAt
    : 0;
  const bufferHealthSeconds = readBufferHealthSeconds(state.player);
  const droppedFrames = readDroppedFrames(state.player);
  const playerStats = summarizePlayerStats(state.player);
  detectVideoFreeze(playerStats);
  const reportedCurrentTime = getReportedCurrentTime();

  fetch("/api/metrics/player", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      currentTime: reportedCurrentTime,
      mediaClockTime: state.currentTime,
      duration: state.duration,
      isPlaying: state.isPlaying,
      isMuted: state.isMuted,
      bufferHealthSeconds,
      buffer: collectBufferState(state.player),
      memory: memorySnapshotForLog(false),
      stallCount: playerMetricsState.stallCount,
      totalStallDurationMs: Math.round(playerMetricsState.totalStallDurationMs + activeStallDurationMs),
      decodePath: playerMetricsState.decodePath,
      droppedFrames,
      playerStats,
      playbackState: getPlaybackState(),
      capabilityProfile: {
        hasWebCodecs: CAPABILITY_PROFILE.hasWebCodecs,
        hasVideoDecoder: CAPABILITY_PROFILE.hasVideoDecoder,
        hasAudioWorklet: CAPABILITY_PROFILE.hasAudioWorklet,
        teslaLikeEnv: CAPABILITY_PROFILE.teslaLikeEnv,
      },
    }),
  }).catch(() => {});
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

  return {
    platform,
    userAgent,
    isLinuxX64,
    hasVideoDecoder,
    hasAudioDecoder,
    hasWebCodecs,
    hasAudioWorklet,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    teslaLikeEnv: isLinuxX64,
  };
}

function reportDecodeInfo(data) {
  if (data?.path) {
    const previousPath = playerRuntimeLogState.lastDecodePath;
    if (previousPath && previousPath !== data.path) {
      postPlayerRuntimeLog("decode_path_change", {
        previousPath,
        nextPath: data.path,
        phase: data.phase || null,
        buffer: collectBufferState(),
      });
    }
    playerRuntimeLogState.lastDecodePath = data.path;
    playerMetricsState.decodePath = data.path;
  }
  fetch("/api/dev/decode-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch(() => {});
}

async function logDecodePath(player, phase, extra = {}) {
  const playerStats = summarizePlayerStats(player);
  const decodeInfo = {
    phase,
    path: "mediabunny-webcodecs",
    playbackState: getPlaybackState(),
    currentTime: state.currentTime,
    duration: state.duration,
    capabilities: CAPABILITY_PROFILE,
    stats: playerStats,
    bufferHealthSeconds: readBufferHealthSeconds(player),
    droppedFrames: readDroppedFrames(player),
    audio: readAudioBufferStats(player),
    canvas: describePlayerCanvas(),
    ...extra,
  };
  console.log("[player] Decode health:", decodeInfo);
  reportDecodeInfo(decodeInfo);
  return decodeInfo;
}

function queueDecodeHealthCheck(player, phase, extra = {}, { jankCooldownMs = 0 } = {}) {
  if (!player) return;

  if (jankCooldownMs > 0) {
    const now = performance.now();
    if (now - decodeHealthState.lastJankReportAt < jankCooldownMs) return;
    decodeHealthState.lastJankReportAt = now;
  }

  logDecodePath(player, phase, extra).catch((error) => {
    console.warn("[player] Failed to report decode health:", error);
  });
}

function startDecodeHealthMonitoring(player) {
  stopDecodeHealthMonitoring();
  decodeHealthInterval = setInterval(() => {
    queueDecodeHealthCheck(state.player, "periodic-60s");
  }, DECODE_HEALTH_INTERVAL_MS);
}

function stopDecodeHealthMonitoring() {
  if (decodeHealthInterval) {
    clearInterval(decodeHealthInterval);
    decodeHealthInterval = null;
  }
}

// --- MediaSession (Tesla steering wheel / browser media keys) --------

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
}

// --- Progress reporting ----------------------------------------------

function getReportedCurrentTime(player = state.player) {
  const stats = summarizePlayerStats(player);
  const videoSeconds = stats?.videoCurrentTimeMs != null ? stats.videoCurrentTimeMs / 1000 : null;
  const audioSeconds = stats?.audioCurrentTimeMs != null ? stats.audioCurrentTimeMs / 1000 : null;
  const hasRenderedVideo = (stats?.videoFrameRenderCount || 0) > 0;
  if (
    hasRenderedVideo
    && Number.isFinite(videoSeconds)
    && videoSeconds > 0
    && Number.isFinite(audioSeconds)
    && audioSeconds - videoSeconds > 2
  ) {
    return Math.max(0, Math.min(state.duration || Infinity, videoSeconds));
  }
  return state.currentTime;
}

export function reportProgress() {
  const reportedCurrentTime = getReportedCurrentTime();
  const ps = {
    currentTime: reportedCurrentTime,
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
        timeMs: reportedCurrentTime * 1000,
      }),
    }).catch(() => {});
  }
  reportPlayerMetrics();
}

async function disposePlayer(player) {
  if (!player) return;
  stopDecodeHealthMonitoring();
  try { await player.stop(); } catch {}
  try { await player.destroy(); } catch {}
}

export async function setAudioGain(value) {
  state.audioGain = clampAudioGain(value);
  persistAudioGain();
  state.player?.setAudioGain(state.audioGain);
  onUpdateAudioUI();
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
    const actuallyPlaying = status === "playing" || status === "buffering";
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

function createMediabunnyPlayer(meta) {
  const updateTime = (seconds) => {
    if (isDraggingProgress()) return;
    state.currentTime = Math.max(0, Math.min(state.duration || Infinity, seconds));
    const now = performance.now();
    if (now - lastUiPaintAt >= UI_PAINT_INTERVAL_MS) {
      if (state.duration > 0) updateProgress(state.currentTime / state.duration);
      updateTimeDisplay();
      lastUiPaintAt = now;
    }
    renderSubtitle(state.currentTime);
  };

  const player = new MediabunnyPlayer({
    container,
    faultInjection: getMediabunnyFaultInjection(),
    onStateChange: (nextState, detail) => {
      if (state.player !== player) return;
      if (["loading", "seeking", "buffering"].includes(nextState)) {
        beginStall();
        showBuffering();
        if (nextState === "buffering") state.isPlaying = true;
      } else if (nextState === "playing") {
        endStall();
        hideBuffering();
        state.isPlaying = true;
        updatePlayButton();
        updateMediaSession();
      } else if (nextState === "paused") {
        endStall();
        hideBuffering();
        state.isPlaying = false;
        updatePlayButton();
        updateMediaSession();
      }
      postPlayerRuntimeLog("mediabunny_state", {
        state: nextState,
        reason: detail.reason || null,
        buffer: collectBufferState(player),
      });
    },
    onTime: updateTime,
    onFirstVideo: () => {
      endStall();
      markPlaybackStable(player);
    },
    onEnded: () => {
      endStall();
      hideBuffering();
      state.isPlaying = false;
      state.currentTime = 0;
      reportProgress();
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "ended" }));
      }
      updatePlayButton();
      updateMediaSession();
      showControls();
    },
    onError: (error) => {
      endStall();
      console.error("[mediabunny] Playback error:", error);
      if (!schedulePlaybackRecovery(player, error)) {
        hideBuffering();
        showStatus(`Error: ${error.message}`);
      }
    },
    onAbrSwitch: async ({
      session,
      switchUrl,
      fromBitrate,
      videoBitrate,
      currentTime,
      reason,
      network,
    }) => {
      postPlayerRuntimeLog("abr_switch_start", {
        session,
        fromBitrate,
        toBitrate: videoBitrate,
        reason,
        network,
      });
      const response = await fetch(switchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session,
          videoBitrate,
          currentTime,
          switchOffset: currentTime + Math.max(0, Number(network?.bufferedAheadSeconds) || 0),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `ABR switch failed with ${response.status}`);
      if (meta.mediaSource?.abr) {
        meta.mediaSource.abr.currentBitrate = result.videoBitrate;
        meta.mediaSource.abr.advertisedBitrate = result.advertisedBitrate || null;
      }
      postPlayerRuntimeLog("abr_switch_end", {
        session,
        fromBitrate,
        toBitrate: result.videoBitrate,
        advertisedBitrate: result.advertisedBitrate || null,
        reason,
      });
      return result;
    },
  });

  player.setAudioGain(state.audioGain);
  globalThis.__driveInMediabunny = {
    player,
    injectVideoStall: (durationMs = 15_000) => player.injectVideoStall(durationMs),
  };
  return player;
}

// --- Play / Stop -----------------------------------------------------

const container = document.getElementById("player-container");
const overlay = document.getElementById("overlay");
const statusText = document.getElementById("status-text");
const subsPanel = document.getElementById("subs-panel");
const audioPanel = document.getElementById("audio-panel");

// Resize canvas when fullscreen or window size changes (debounced to avoid perf impact)
let resizeTimer = null;
function handleResize() {
  if (resizeTimer) return;
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    if (state.player?.resize) {
      try {
        state.player.resize(container.clientWidth, container.clientHeight);
      } catch {}
    }
  }, 150);
}
window.addEventListener("resize", handleResize, { passive: true });
document.addEventListener("fullscreenchange", handleResize);
document.addEventListener("webkitfullscreenchange", handleResize);
const btnAudio = document.getElementById("btn-audio");

export function showStatus(text) {
  statusText.textContent = text;
  overlay.classList.remove("hidden");
}

export async function play(url, title, meta = {}) {
  if (state.playLock) return;
  state.playLock = true;
  const playbackSessionId = ++playbackSessionSequence;
  const isRecovery = meta.__recovery === true;
  if (!isRecovery) {
    resetPlaybackRecovery();
    const requestMeta = { ...meta };
    delete requestMeta.__recovery;
    playbackRecoveryState.request = { url, title, meta: requestMeta };
  }

  try {
    ensureLongTaskObserver();
    resetPlayerMetrics();
    resetStutterTelemetry();
    resetDecodeHealthState();
    resetPlayerRuntimeLogState();
    playerRuntimeLogState.playbackSessionId = playbackSessionId;

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
    navigate(playPath);

    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    state.player = createMediabunnyPlayer(meta);
    startProgressReporting();
    startStutterTelemetryReporting();
    startPlayerHealthHeartbeat();
    startDecodeHealthMonitoring(state.player);

    console.log("[player] Loading with Mediabunny:", absUrl);
    reportDecodeInfo({
      options: { engine: "mediabunny", clock: "audio-consumed-samples" },
      capabilities: {
        crossOriginIsolated: globalThis.crossOriginIsolated,
        hasVideoDecoder: CAPABILITY_PROFILE.hasVideoDecoder,
        hasAudioDecoder: CAPABILITY_PROFILE.hasAudioDecoder,
        hasAudioWorklet: typeof AudioWorkletNode === "function",
      },
      decodePreference: "webcodecs-hardware-with-drivein-coordinator",
    });
    await state.player.load(meta.mediaSource || absUrl, {
      isLive: meta.isLive || false,
      startTime: state.currentTime,
      duration: state.duration,
    });

    if (!state.duration) {
      const duration = state.player.getDuration();
      if (duration > 0n) state.duration = Number(duration) / 1000;
    }
    updateTimeDisplay();

    const activePlexSubtitle = state.plexInfo?.subtitles?.find((subtitle) => (
      subtitle.delivery === "external"
      && String(subtitle.id) === String(state.plexInfo.activeSubtitleID)
    ));
    if (activePlexSubtitle?.url) {
      await loadSubtitleTrack(`plex:${activePlexSubtitle.id}`, activePlexSubtitle.url);
    }

    if (!state.audioUnlocked) {
      state.player.setVolume(0);
      state.isMuted = true;
      updateVolumeButton();
    }

    await state.player.play();
    state.isPlaying = true;
    onUpdateAudioUI();
    updatePlayButton();
    showControls();
    updateMediaSession();

  } catch (e) {
    console.error("[player] Playback error:", e);
    stopProgressReporting();
    stopStutterTelemetryReporting();
    stopPlayerHealthHeartbeat();
    // Tear down partially initialized players so retry loops do not retain decoders or canvases.
    const failedPlayer = state.player;
    state.player = null;
    await disposePlayer(failedPlayer);
    showStatus(`Error: ${e.message}`);
  } finally {
    state.playLock = false;
  }
}

export async function stop() {
  resetPlaybackRecovery({ clearRequest: true });
  endStall();
  clearScheduledStutterTelemetryFlush();
  flushStutterTelemetry("stop", { keepalive: true });
  reportProgress();
  stopProgressReporting();
  stopStutterTelemetryReporting();
  stopPlayerHealthHeartbeat();
  stopDecodeHealthMonitoring();
  const player = state.player;
  state.player = null;
  await disposePlayer(player);
  container.innerHTML = "";
  state.isPlaying = false;
  state.plexInfo = null;
  state.sourceUrl = null;
  state.currentTime = 0;
  state.duration = 0;
  state.externalSubs = [];
  state.activeExternalSubs.clear();
  // Clear subtitle cues on stop so large parsed VTT arrays are released as soon as playback ends.
  disableExternalSubtitle();
  lastUiPaintAt = 0;
  onUpdateAudioUI();
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
    }
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    if (state.player && state.isPlaying) {
      state.player.pause().catch(() => {});
      state.isPlaying = false;
      updatePlayButton();
      updateMediaSession();
    }
  });
  navigator.mediaSession.setActionHandler("stop", () => {
    stop();
  });
}
