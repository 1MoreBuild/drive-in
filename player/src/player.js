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
const DEFAULT_AUDIO_GAIN = 12.0;
const MIN_AUDIO_GAIN = 1.0;
const MAX_AUDIO_GAIN = 10.0;
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
const DECODE_HEALTH_INTERVAL_MS = 60_000;
const DECODE_JANK_RECHECK_COOLDOWN_MS = 15_000;
const STUTTER_EVENT_CAPACITY = 100;
const STUTTER_REPORT_INTERVAL_MS = 30_000;
// libmedia TIME events fire at ~1000ms intervals (not per-frame), so threshold must be well above that
const STUTTER_JANK_THRESHOLD_MS = 2000;
const STUTTER_LONG_TASK_THRESHOLD_MS = 50;
const STUTTER_MEMORY_SAMPLE_INTERVAL_MS = 15_000;
const STUTTER_AUDIO_SAMPLE_INTERVAL_MS = 1_000;
const STUTTER_FLUSH_IDLE_TIMEOUT_MS = 1_000;
const PLAYER_HEALTH_HEARTBEAT_INTERVAL_MS = 30_000;
const PLAYER_LOG_ENDPOINT = "/api/dev/player-log";
const SLOW_SEGMENT_FETCH_MS = 3_000;
const PLAYBACK_RATE_DROP_COOLDOWN_MS = 5_000;
const AUDIO_UNDERRUN_COOLDOWN_MS = 2_000;
const MEMORY_PRESSURE_GROWTH_BYTES = 8 * 1024 * 1024;
const MEMORY_PRESSURE_GROWTH_RATIO = 0.15;
// libmedia's VideoDecodePipeline blocks packet pulls while WebVideoDecoder
// decodeQueueSize is above 20, but AVPlayer does not expose the per-task
// decoder instance or queue depth through its public thread/proxy APIs.
const LIBMEDIA_WEB_CODECS_QUEUE_LIMIT = 20;
const PLAYER_CANVAS_DIAGNOSTICS_KEY = "__driveInCanvasDiagnostics";
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
let canvasMonitorObserver = null;
let playerHealthHeartbeatInterval = null;
const originalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;

function defaultDecodePath() {
  return CAPABILITY_PROFILE.hasVideoDecoder
    ? "prefer-webcodecs-hardware"
    : CAPABILITY_PROFILE.hasWebCodecs
      ? "prefer-webcodecs"
      : "wasm-fallback";
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
  };
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
  return snapshot
    ? {
        timestamp: snapshot.timestamp,
        usedJSHeapSize: snapshot.usedJSHeapSize,
        totalJSHeapSize: snapshot.totalJSHeapSize,
        jsHeapSizeLimit: snapshot.jsHeapSizeLimit,
        heapGrowthBytes: snapshot.heapGrowthBytes,
      }
    : null;
}

function collectBufferState(player = state.player) {
  const { bufferedAudioMs, underrunCount } = readAudioBufferStats(player);
  return {
    bufferHealthSeconds: readBufferHealthSeconds(player),
    bufferedAudioMs,
    audioUnderrunCount: underrunCount,
  };
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

function readLibmediaStats(player) {
  try {
    const stats = player?.getStats?.();
    return stats && typeof stats === "object" ? stats : null;
  } catch {
    return null;
  }
}

function summarizeLibmediaStats(player) {
  const stats = readLibmediaStats(player);
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
    jitterBuffer,
  };
}

function getVideoDecodePipeline(player) {
  const pipelineProxy = player?.VideoPipelineProxy?.VideoDecodePipeline;
  if (pipelineProxy && typeof pipelineProxy.getTasksInfo === "function") return pipelineProxy;

  const decoderThread = player?.VideoDecoderThread;
  if (decoderThread && typeof decoderThread.getTasksInfo === "function") return decoderThread;

  return null;
}

async function readVideoDecodeTasks(player) {
  const pipeline = getVideoDecodePipeline(player);
  if (!pipeline || typeof pipeline.getTasksInfo !== "function") return null;

  try {
    const tasks = await pipeline.getTasksInfo();
    return Array.isArray(tasks) ? tasks : null;
  } catch (error) {
    console.warn("[player] Failed to inspect video decode tasks:", error);
    return null;
  }
}

function readPlayerOptions(player) {
  try {
    const options = player?.getOptions?.();
    return options && typeof options === "object" ? options : null;
  } catch {
    return null;
  }
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
  const memorySnapshot = sampleMemoryUsage(performance.now(), true);
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
      memory: memorySnapshot
        ? {
            timestamp: memorySnapshot.timestamp,
            usedJSHeapSize: memorySnapshot.usedJSHeapSize,
            totalJSHeapSize: memorySnapshot.totalJSHeapSize,
            jsHeapSizeLimit: memorySnapshot.jsHeapSizeLimit,
            heapGrowthBytes: memorySnapshot.heapGrowthBytes,
          }
        : null,
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

function reportPlayerMetrics() {
  const activeStallDurationMs = playerMetricsState.stallStartedAt
    ? performance.now() - playerMetricsState.stallStartedAt
    : 0;
  const bufferHealthSeconds = readBufferHealthSeconds(state.player);
  const droppedFrames = readDroppedFrames(state.player);
  const libmediaStats = summarizeLibmediaStats(state.player);

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
      libmediaStats,
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
    // libmedia's own default VOD preload is 4 seconds. Keep this override much
    // closer to that baseline so long videos do not build oversized packet
    // queues before decode/render catches up on constrained Chromium builds.
    preLoadTime: constrainedWebCodecsEnv ? 8 : hasWebCodecs ? 12 : 20,
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
  const options = readPlayerOptions(player);
  const requested = {
    enableHardware: options?.enableHardware ?? CAPABILITY_PROFILE.hasVideoDecoder,
    enableWebCodecs: options?.enableWebCodecs ?? CAPABILITY_PROFILE.hasWebCodecs,
    enableWorker: options?.enableWorker ?? CAPABILITY_PROFILE.enableWorker,
    enableAudioWorklet: options?.enableAudioWorklet ?? CAPABILITY_PROFILE.hasAudioWorklet,
    preLoadTime: options?.preLoadTime ?? CAPABILITY_PROFILE.preLoadTime,
  };
  const summary = {
    phase,
    playbackState: getPlaybackState(),
    currentTime: state.currentTime,
    duration: state.duration,
    webCodecsEnabled: requested.enableWebCodecs,
    hardwareAccelerationRequested: requested.enableHardware,
    constrainedWebCodecsEnv: CAPABILITY_PROFILE.constrainedWebCodecsEnv,
    requested,
    ...extra,
  };
  const libmediaStats = summarizeLibmediaStats(player);
  const bufferHealthSeconds = readBufferHealthSeconds(player);
  const droppedFrames = readDroppedFrames(player);
  const { bufferedAudioMs, underrunCount } = readAudioBufferStats(player);
  const tasks = await readVideoDecodeTasks(player);

  if (Array.isArray(tasks) && tasks.length > 0) {
    const usesHardwareDecoder = tasks.some((task) => task?.hardware === true);
    const decodeInfo = {
      ...summary,
      path: usesHardwareDecoder
        ? "webcodecs-hardware"
        : requested.enableWebCodecs
          ? "software-decode"
          : "wasm",
      softDecodePathVisibility: usesHardwareDecoder
        ? "exact"
        : requested.enableWebCodecs
          ? "ambiguous"
          : "exact",
      backpressure: {
        webCodecsQueueLimit: LIBMEDIA_WEB_CODECS_QUEUE_LIMIT,
        queueDepthExposed: false,
      },
      notes: usesHardwareDecoder || !requested.enableWebCodecs
        ? undefined
        : "libmedia AVPlayer exposes hardware=false for soft decode but not whether the active decoder is WebCodecs or WASM.",
      tasks: tasks.map((task) => ({
        codecId: task.codecId,
        width: task.width,
        height: task.height,
        framerate: task.framerate,
        hardware: task.hardware,
      })),
      stats: libmediaStats,
      bufferHealthSeconds,
      droppedFrames,
      bufferedAudioMs,
      audioUnderrunCount: underrunCount,
      isMSE: typeof player?.isMSE === "function" ? player.isMSE() : null,
      canvas: describePlayerCanvas(),
    };
    console.log("[player] Decode health:", decodeInfo);
    reportDecodeInfo(decodeInfo);
    return decodeInfo;
  }

  const decodeInfo = {
    ...summary,
    path: requested.enableWebCodecs ? "webcodecs-requested" : "wasm-only",
    backpressure: {
      webCodecsQueueLimit: LIBMEDIA_WEB_CODECS_QUEUE_LIMIT,
      queueDepthExposed: false,
    },
    stats: libmediaStats,
    bufferHealthSeconds,
    droppedFrames,
    bufferedAudioMs,
    audioUnderrunCount: underrunCount,
    isMSE: typeof player?.isMSE === "function" ? player.isMSE() : null,
    canvas: describePlayerCanvas(),
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
  attachCanvasDiagnostics(player);
  decodeHealthInterval = setInterval(() => {
    queueDecodeHealthCheck(state.player, "periodic-60s");
  }, DECODE_HEALTH_INTERVAL_MS);
}

function stopDecodeHealthMonitoring() {
  if (decodeHealthInterval) {
    clearInterval(decodeHealthInterval);
    decodeHealthInterval = null;
  }
  detachCanvasDiagnostics();
}

// Intercept console to capture libmedia internal logs and forward to server
// libmedia logs format: console.log("[file][line N] [level]", message)
const libmediaLogBuffer = [];
let libmediaLogFlushTimer = null;
const LIBMEDIA_TAG_RE = /\[.*\]\[line \d+\] \[(trace|debug|info|warn|error|fatal)\]/;

function installLibmediaLogCapture() {
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;

  function captureLog(level, args) {
    // libmedia passes tag as first arg, message as second
    const tag = typeof args[0] === "string" ? args[0] : "";
    const isLibmedia = LIBMEDIA_TAG_RE.test(tag);
    if (!isLibmedia) return;
    const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    libmediaLogBuffer.push({ ts: Date.now(), level, msg: msg.slice(0, 500), pos: state.currentTime || 0 });
    if (libmediaLogBuffer.length > 200) libmediaLogBuffer.shift();
    if (!libmediaLogFlushTimer) {
      libmediaLogFlushTimer = setTimeout(flushLibmediaLogs, 5000);
    }
  }

  console.log = (...args) => { captureLog("log", args); originalLog.apply(console, args); };
  console.warn = (...args) => { captureLog("warn", args); originalWarn.apply(console, args); };
  console.error = (...args) => { captureLog("error", args); originalError.apply(console, args); };
}

function flushLibmediaLogs() {
  libmediaLogFlushTimer = null;
  if (!libmediaLogBuffer.length) return;
  const batch = libmediaLogBuffer.splice(0);
  try {
    navigator.sendBeacon("/api/dev/player-log", new Blob(
      [JSON.stringify({ type: "libmedia_logs", entries: batch, timestamp: Date.now() })],
      { type: "application/json" }
    ));
  } catch {
    fetch("/api/dev/player-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "libmedia_logs", entries: batch, timestamp: Date.now() }),
      keepalive: true,
    }).catch(() => {});
  }
}

async function loadAVPlayerClass() {
  if (AVPlayerClass) return;
  const mod = await import("@libmedia/avplayer");
  AVPlayerClass = mod.default || mod.AVPlayer || mod;
  AVPlayerEvents = mod.Events;
  // Enable libmedia internal logging — DEBUG (1) shows decoder switching, errors, pipeline state
  try { AVPlayerClass.setLogLevel(1); } catch {}
  installLibmediaLogCapture();
  console.log("[player] AVPlayer class loaded (log level: DEBUG, server forwarding enabled)");
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
  stopDecodeHealthMonitoring();
  teardownAudioBoost();
  try { await player.stop(true); } catch {}
  try { await player.destroy(); } catch {}
}

async function resumePlayerAudioContext() {
  try {
    if (AVPlayerClass?.audioContext?.state === "suspended") {
      await AVPlayerClass.audioContext.resume();
    }
  } catch {}
}

function teardownAudioBoost() {
  const { audioBoostNode, audioOutputNode, audioCompressorNode } = state;
  state.audioBoostNode = null;
  state.audioOutputNode = null;
  state.audioCompressorNode = null;

  try { audioBoostNode?.disconnect(); } catch {}
  try { audioCompressorNode?.disconnect(); } catch {}
  try { audioOutputNode?.disconnect(); } catch {}
}

async function attachAudioBoost(player) {
  if (!player || typeof player.getAudioOutputNode !== "function") return;

  await resumePlayerAudioContext();

  const audioContext = AVPlayerClass?.audioContext;
  if (!audioContext || typeof audioContext.createGain !== "function") return;
  if (typeof player.isMediaStreamMode === "function" && player.isMediaStreamMode()) return;

  let outputNode = null;
  try {
    outputNode = player.getAudioOutputNode();
  } catch (error) {
    console.warn("[player] Failed to inspect audio output node:", error);
    return;
  }
  if (!outputNode || typeof outputNode.connect !== "function") return;

  if (state.audioOutputNode === outputNode && state.audioBoostNode) {
    state.audioBoostNode.gain.value = state.audioGain;
    return;
  }

  teardownAudioBoost();

  const boostNode = audioContext.createGain();
  boostNode.gain.value = state.audioGain;

  // Compressor prevents clipping when gain is high — louder without distortion
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -24;  // start compressing at -24dB
  compressor.knee.value = 12;        // soft knee for natural sound
  compressor.ratio.value = 8;        // strong compression on peaks
  compressor.attack.value = 0.003;   // fast attack to catch transients
  compressor.release.value = 0.15;   // moderate release

  try {
    outputNode.disconnect();
  } catch {}

  try {
    outputNode.connect(boostNode);
    boostNode.connect(compressor);
    compressor.connect(audioContext.destination);
    state.audioOutputNode = outputNode;
    state.audioBoostNode = boostNode;
    state.audioCompressorNode = compressor;
    console.log("[player] Audio boost + compressor connected", { gain: state.audioGain });
  } catch (error) {
    console.warn("[player] Failed to connect audio boost:", error);
    try {
      outputNode.connect(audioContext.destination);
    } catch {}
    try {
      boostNode.disconnect();
    } catch {}
  }
}

export async function setAudioGain(value) {
  state.audioGain = clampAudioGain(value);
  persistAudioGain();
  if (state.audioBoostNode) {
    if (state.audioBoostNode.gain.value !== state.audioGain) {
      state.audioBoostNode.gain.value = state.audioGain;
    }
  } else if (state.player) {
    await attachAudioBoost(state.player);
  }
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
    queueDecodeHealthCheck(p, "first-video-frame");
  };
  const onFirstAudioRendered = () => {
    attachAudioBoost(p).catch(() => {});
  };
  const onSeeking = () => showBuffering();
  const onSeeked = () => hideBuffering();
  const onTime = (pts) => {
    if (isDraggingProgress()) return;
    playerRuntimeLogState.frameCount += 1;
    const ptsMs = Number(pts);
    state.currentTime = ptsMs / 1000;
    if (state.duration > 0) state.currentTime = Math.min(state.currentTime, state.duration);

    const now = performance.now();
    if (stutterTelemetryState.lastTimeCallbackAt) {
      const actualDeltaMs = now - stutterTelemetryState.lastTimeCallbackAt;
      const ptsDeltaMs = Math.max(0, ptsMs - stutterTelemetryState.lastTimePtsMs);
      const expectedDeltaMs = inferExpectedFrameDeltaMs(ptsDeltaMs);
      stutterTelemetryState.lastExpectedDeltaMs = expectedDeltaMs;

      if (actualDeltaMs > STUTTER_JANK_THRESHOLD_MS) {
        playerRuntimeLogState.jankCount += 1;
        recordStutterEvent("frame_jank", {
          playbackPosition: state.currentTime,
          expectedDeltaMs,
          actualDeltaMs,
        });
        queueStutterTelemetryReport("frame-jank");
        queueDecodeHealthCheck(p, "time-jank", {
          actualDeltaMs: Math.round(actualDeltaMs),
          expectedDeltaMs: Math.round(expectedDeltaMs),
          ptsDeltaMs: Math.round(ptsDeltaMs),
        }, {
          jankCooldownMs: DECODE_JANK_RECHECK_COOLDOWN_MS,
        });
      }

      if (state.isPlaying && ptsDeltaMs > 0 && actualDeltaMs >= 250) {
        const effectiveRate = ptsDeltaMs / actualDeltaMs;
        if (
          effectiveRate < 0.99
          && now - stutterTelemetryState.lastRateDropLoggedAt >= PLAYBACK_RATE_DROP_COOLDOWN_MS
        ) {
          stutterTelemetryState.lastRateDropLoggedAt = now;
          recordStutterEvent("playback_rate_drop", {
            playbackPosition: state.currentTime,
            effectiveRate,
            actualDeltaMs,
          });
        }
      }
    }
    stutterTelemetryState.lastTimeCallbackAt = now;
    stutterTelemetryState.lastTimePtsMs = ptsMs;
    sampleMemoryUsage(now);
    sampleAudioUnderruns(p, now);

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
    attachAudioBoost(p).catch(() => {});
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
    queueDecodeHealthCheck(p, "player-error", {
      errorMessage: err?.message || String(err),
    });
    hideBuffering();
  };
  const onTimeout = () => {
    console.warn("[player] Timeout — network may be slow");
    queueDecodeHealthCheck(p, "player-timeout");
  };
  const onAudioContextRunning = () => {
    attachAudioBoost(p).catch(() => {});
  };

  currentPlayerBindings = [
    [AVPlayerEvents.LOADING, onLoading],
    [AVPlayerEvents.LOADED, onLoaded],
    [AVPlayerEvents.FIRST_VIDEO_RENDERED, onFirstVideoRendered],
    [AVPlayerEvents.FIRST_AUDIO_RENDERED, onFirstAudioRendered],
    [AVPlayerEvents.SEEKING, onSeeking],
    [AVPlayerEvents.SEEKED, onSeeked],
    [AVPlayerEvents.TIME, onTime],
    [AVPlayerEvents.PLAYING, onPlaying],
    [AVPlayerEvents.PAUSED, onPaused],
    [AVPlayerEvents.ENDED, onEnded],
    [AVPlayerEvents.ERROR, onError],
    [AVPlayerEvents.TIMEOUT, onTimeout],
    [AVPlayerEvents.AUDIO_CONTEXT_RUNNING, onAudioContextRunning],
  ].filter(([event]) => !!event);

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

function bindCanvasDiagnostics(canvas, player) {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  if (canvas[PLAYER_CANVAS_DIAGNOSTICS_KEY]) return;

  const onContextLost = (event) => {
    event.preventDefault?.();
    console.warn("[player] WebGL context lost");
    queueDecodeHealthCheck(player, "webgl-context-lost", {
      contextEvent: "lost",
    });
  };
  const onContextRestored = () => {
    console.log("[player] WebGL context restored");
    try {
      player?.resize?.(container.clientWidth, container.clientHeight);
    } catch {}
    queueDecodeHealthCheck(player, "webgl-context-restored", {
      contextEvent: "restored",
    });
  };
  const onContextCreationError = (event) => {
    console.warn("[player] WebGL context creation error", event?.statusMessage || event);
    queueDecodeHealthCheck(player, "webgl-context-creation-error", {
      contextEvent: "creation-error",
      statusMessage: event?.statusMessage || null,
    });
  };

  canvas.addEventListener("webglcontextlost", onContextLost, { passive: false });
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  canvas.addEventListener("webglcontextcreationerror", onContextCreationError);
  canvas[PLAYER_CANVAS_DIAGNOSTICS_KEY] = {
    onContextLost,
    onContextRestored,
    onContextCreationError,
  };
}

function detachCanvasDiagnostics() {
  if (canvasMonitorObserver) {
    canvasMonitorObserver.disconnect();
    canvasMonitorObserver = null;
  }

  for (const canvas of container.querySelectorAll("canvas")) {
    const diagnostics = canvas[PLAYER_CANVAS_DIAGNOSTICS_KEY];
    if (!diagnostics) continue;
    canvas.removeEventListener("webglcontextlost", diagnostics.onContextLost);
    canvas.removeEventListener("webglcontextrestored", diagnostics.onContextRestored);
    canvas.removeEventListener("webglcontextcreationerror", diagnostics.onContextCreationError);
    delete canvas[PLAYER_CANVAS_DIAGNOSTICS_KEY];
  }
}

function attachCanvasDiagnostics(player) {
  detachCanvasDiagnostics();

  const bindExistingCanvases = () => {
    for (const canvas of container.querySelectorAll("canvas")) {
      bindCanvasDiagnostics(canvas, player);
    }
  };

  bindExistingCanvases();

  if (typeof MutationObserver !== "function") return;
  canvasMonitorObserver = new MutationObserver(() => {
    bindExistingCanvases();
  });
  canvasMonitorObserver.observe(container, { childList: true, subtree: true });
}

export function showStatus(text) {
  statusText.textContent = text;
  overlay.classList.remove("hidden");
}

export async function play(url, title, meta = {}) {
  if (state.playLock) return;
  state.playLock = true;

  try {
    await loadAVPlayerClass();
    ensureLongTaskObserver();
    resetPlayerMetrics();
    resetStutterTelemetry();
    resetDecodeHealthState();
    resetPlayerRuntimeLogState();

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
    startStutterTelemetryReporting();
    startPlayerHealthHeartbeat();
    startDecodeHealthMonitoring(state.player);

    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    console.log("[player] Loading:", absUrl);
    await state.player.load(absUrl, { isLive: meta.isLive || false });
    await attachAudioBoost(state.player);
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
    await attachAudioBoost(state.player);
    if (state.currentTime > 5) {
      const seekMs = BigInt(Math.floor(state.currentTime * 1000));
      try { await state.player.seek(seekMs); } catch (e) { console.warn("[player] Seek failed:", e); }
    }
    state.isPlaying = true;
    onUpdateAudioUI();
    updatePlayButton();
    hideBuffering();
    showControls();
    updateMediaSession();

  } catch (e) {
    console.error("[player] Playback error:", e);
    stopProgressReporting();
    stopStutterTelemetryReporting();
    stopPlayerHealthHeartbeat();
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
  clearScheduledStutterTelemetryFlush();
  flushStutterTelemetry("stop", { keepalive: true });
  reportProgress();
  stopProgressReporting();
  stopStutterTelemetryReporting();
  stopPlayerHealthHeartbeat();
  stopDecodeHealthMonitoring();
  const player = state.player;
  state.player = null;
  teardownAudioBoost();
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
