import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { execFile, execSync, spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import pinoHttp from "pino-http";
import httpProxy from "http-proxy";
import log from "./logger.js";
import {
  addPlaylistItem,
  createPlaylist,
  addQueueItem,
  clearQueue,
  deletePlaylist,
  enqueuePlaylist,
  getPlaylist,
  getQueueItem,
  listPlaylists,
  listQueue,
  removeQueueItem,
  removePlaylistItem,
  reorderQueue,
  reorderPlaylistItems,
  shiftQueueItem,
  updatePlaylist,
} from "./queue-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "9090", 10);
const PLEX_URL = process.env.PLEX_URL || "http://localhost:32400";
const PROXY_TTL_MS = 3600_000;
const PROXY_REFRESH_SKEW_MS = 5 * 60_000;
const SEGMENT_CACHE_DIR = resolve(__dirname, "../.segment-cache");
const SEGMENT_CACHE_MAX_BYTES = (() => {
  const parsed = Number(process.env.SEGMENT_CACHE_MAX_BYTES);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 20 * 1024 * 1024 * 1024;
})();
const SEGMENT_CACHE_MIN_BYTES = 10 * 1024;
const SEGMENT_CACHE_TARGET_BYTES = Math.floor(SEGMENT_CACHE_MAX_BYTES * 0.9);
const SEGMENT_CACHE_EVICT_DEBOUNCE_MS = 60_000;
const SEGMENT_CACHE_MAX_PREFETCHES = 3;
// Keep roughly 30 seconds of split-stream media warm. The canvas player only
// holds a small decoded-frame queue, so network jitter must be absorbed here.
const SEGMENT_PREFETCH_AHEAD = 6;
const DASH_SEGMENT_INACTIVITY_TIMEOUT_MS = 6_000;
const DASH_SEGMENT_FETCH_RETRIES = 2;
const DASH_SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const PLEX_TOKEN = process.env.PLEX_TOKEN || (() => {
  try { return execSync("defaults read com.plexapp.plexmediaserver PlexOnlineToken 2>/dev/null").toString().trim(); }
  catch { return ""; }
})();

// --- Play history (persisted to disk) --------------------------------

const HISTORY_PATH = resolve(__dirname, "../.play-history.json");
const MAX_HISTORY = 30;

function loadHistory() {
  try { return JSON.parse(readFileSync(HISTORY_PATH, "utf-8")); }
  catch { return []; }
}

function saveHistory(history) {
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function addToHistory(entry) {
  const history = loadHistory();
  // Remove duplicate (same ratingKey or url)
  const key = entry.plex?.ratingKey || entry.url;
  const filtered = history.filter((h) => (h.plex?.ratingKey || h.url) !== key);
  // Add to front
  filtered.unshift({
    title: entry.title,
    url: entry.url || null,
    plex: entry.plex || null,
    thumbnail: entry.thumbnail || null,
    duration: entry.duration || null,
    progress: entry.progress || null,
    playedAt: Date.now(),
  });
  // Trim
  saveHistory(filtered.slice(0, MAX_HISTORY));
}

const app = express();
app.use(express.json());

// COOP/COEP headers — required by the shared audio ring buffer.
app.use((req, res, next) => {
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "credentialless");
  next();
});

// Structured request logging
app.use(pinoHttp({
  logger: log,
  autoLogging: {
    ignore: (req) => req.url === "/api/health" || req.url === "/favicon.ico"
      || (req.url.startsWith("/lib/") || req.url.startsWith("/src/") || req.url.endsWith(".css") || req.url.endsWith(".js") || req.url.endsWith(".html")),
  },
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
}));

const mediabunnyDist = resolve(__dirname, "../node_modules/mediabunny/dist/bundles");
app.use("/lib/mediabunny", express.static(mediabunnyDist));

// Serve player: use dist in production, source in dev
const playerDist = resolve(__dirname, "../player/dist");
const playerSrc = resolve(__dirname, "../player");
const serveDist = process.env.SERVE_SOURCE !== "1" && existsSync(resolve(playerDist, "index.html"));
if (serveDist) {
  log.info("Serving player from dist/ (production build)");
  app.use(express.static(playerDist, {
    extensions: ["html"],
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes("/assets/")) {
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.set("Cache-Control", "no-store");
      }
    },
  }));
} else {
  log.info("Serving player from source (dev mode — run 'npm run build -w player' for production)");
  app.use(express.static(playerSrc, {
    extensions: ["html"],
    etag: false,
    lastModified: false,
    setHeaders: (res) => { res.set("Cache-Control", "no-store"); },
  }));
}

// --- State -----------------------------------------------------------

let playerWs = null; // the single connected Tesla browser
const state = {
  status: "idle", // idle | resolving | playing | paused
  url: null,
  title: null,
  resolvedUrl: null,
  isLive: false,
};
// Live player state reported via WebSocket
let playerState = {};
let latestPlayerMetrics = null;
let latestStutterLog = null;
// Current non-Plex subtitle tracks (from yt-dlp)
let currentSubtitles = []; // [{ lang, name, url, auto, filename }]
let currentSubsCacheKey = null;

// --- Real-time metrics ----------------------------------------------

const METRICS_WINDOW_MS = 60_000;
const SLOW_PROXY_RESPONSE_MS = 2_000;
const LOW_PROXY_THROUGHPUT_BPS = 500 * 1024;
const metricsState = {
  byteSamples: [],
  responseTimes: [],
  activeProxyConnections: 0,
  totalBytesServed: 0,
};

function pruneMetrics(now = Date.now()) {
  const cutoff = now - METRICS_WINDOW_MS;
  while (metricsState.byteSamples.length && metricsState.byteSamples[0].ts < cutoff) {
    metricsState.byteSamples.shift();
  }
  while (metricsState.responseTimes.length && metricsState.responseTimes[0].ts < cutoff) {
    metricsState.responseTimes.shift();
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function beginProxyMetric(endpoint) {
  metricsState.activeProxyConnections++;
  return {
    endpoint,
    startedAt: Date.now(),
    bytes: 0,
    finished: false,
    proxyId: null,
    url: null,
    originalUrl: null,
    range: null,
    upstreamStatus: null,
    upstreamContentLength: null,
    upstreamResponseTimeMs: null,
    error: null,
  };
}

function truncateUrl(url, max = 200) {
  if (!url) return null;
  return url.length > max ? `${url.slice(0, max)}...` : url;
}

function proxyEntryAgeMs(entry, now = Date.now()) {
  const registeredAt = entry?.ts || entry?.createdAt || entry?.lastAccessAt;
  return registeredAt ? now - registeredAt : null;
}

function setProxyMetricRequest(metric, req, entry, proxyId, range = null) {
  if (!metric) return;
  metric.proxyId = proxyId || null;
  metric.url = entry?.url || null;
  metric.originalUrl = entry?.originalUrl || null;
  metric.range = range || req.headers.range || null;
}

function setProxyMetricUpstream(metric, upstream, upstreamResponseTimeMs = null) {
  if (!metric || !upstream) return;
  metric.upstreamStatus = upstream.status;
  const contentLength = upstream.headers?.get?.("content-length");
  metric.upstreamContentLength = contentLength ? Number(contentLength) : null;
  metric.upstreamResponseTimeMs = upstreamResponseTimeMs;
}

function logProxyUrlHealth({ level = "warn", proxyId, entry, status = null, err = null, event }) {
  const now = Date.now();
  const payload = {
    event,
    proxyId,
    status,
    originalUrl: truncateUrl(entry?.originalUrl || entry?.url, 80),
    proxyEntryAgeMs: proxyEntryAgeMs(entry, now),
    err: err ? (err.message || String(err)) : status ? `upstream_${status}` : null,
  };
  log[level](payload, "Proxy URL health degraded");
}

function warnOnProxyStatus(proxyId, entry, upstream, event = "upstream_status") {
  if (!upstream || (upstream.status !== 403 && upstream.status !== 410)) return;
  logProxyUrlHealth({ proxyId, entry, status: upstream.status, event });
}

function recordProxyMetricBytes(metric, bytes) {
  if (!metric || metric.finished || !Number.isFinite(bytes) || bytes <= 0) return;
  metric.bytes += bytes;
  metricsState.byteSamples.push({ ts: Date.now(), bytes, endpoint: metric.endpoint });
  pruneMetrics();
}

function finishProxyMetric(metric) {
  if (!metric || metric.finished) return;
  metric.finished = true;
  metricsState.activeProxyConnections = Math.max(0, metricsState.activeProxyConnections - 1);
  metricsState.totalBytesServed += metric.bytes;
  const now = Date.now();
  const durationMs = now - metric.startedAt;
  metricsState.responseTimes.push({
    ts: now,
    durationMs,
    endpoint: metric.endpoint,
  });
  pruneMetrics();

  const bytesPerSecond = durationMs > 0 ? metric.bytes / (durationMs / 1000) : null;
  const degraded = durationMs > SLOW_PROXY_RESPONSE_MS
    || (metric.upstreamStatus != null && metric.upstreamStatus !== 200)
    || (bytesPerSecond != null && metric.bytes > 0 && bytesPerSecond < LOW_PROXY_THROUGHPUT_BPS)
    || !!metric.error;
  const payload = {
    endpoint: metric.endpoint,
    proxyId: metric.proxyId,
    url: truncateUrl(metric.url, 300),
    originalUrl: truncateUrl(metric.originalUrl, 120),
    range: metric.range,
    upstreamStatus: metric.upstreamStatus,
    upstreamContentLength: metric.upstreamContentLength,
    upstreamResponseTimeMs: metric.upstreamResponseTimeMs,
    responseTimeMs: durationMs,
    bytesServed: metric.bytes,
    bytesPerSecond,
    totalBytesServed: metricsState.totalBytesServed,
    err: metric.error,
  };
  log[degraded ? "warn" : "info"](payload, "Proxy request completed");
}

function trackProxyMetricLifecycle(res, metric) {
  res.once("finish", () => finishProxyMetric(metric));
  res.once("close", () => finishProxyMetric(metric));
}

function getMetricsSnapshot() {
  pruneMetrics();
  const bytesInWindow = metricsState.byteSamples.reduce((sum, sample) => sum + sample.bytes, 0);
  const durations = metricsState.responseTimes.map((sample) => sample.durationMs);
  const cacheHitTotal = segmentCacheState.hits + segmentCacheState.misses;
  const playerMetrics = latestPlayerMetrics
    ? {
        ...latestPlayerMetrics,
        currentTime: latestPlayerMetrics.currentTime ?? playerState.currentTime ?? null,
        duration: latestPlayerMetrics.duration ?? playerState.duration ?? null,
        isPlaying: latestPlayerMetrics.isPlaying ?? playerState.isPlaying ?? null,
        isMuted: latestPlayerMetrics.isMuted ?? playerState.isMuted ?? null,
      }
    : Object.keys(playerState).length
      ? { ...playerState, playbackState: playerState.isPlaying ? "playing" : "paused" }
      : null;

  return {
    generatedAt: Date.now(),
    windowMs: METRICS_WINDOW_MS,
    server: {
      throughput: {
        rollingBytesPerSecond: bytesInWindow / (METRICS_WINDOW_MS / 1000),
        windowBytes: bytesInWindow,
      },
      segmentDelivery: {
        sampleCount: durations.length,
        avgResponseTimeMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
        p95ResponseTimeMs: percentile(durations, 0.95),
      },
      segmentCache: {
        sizeBytes: segmentCacheState.sizeBytes,
        maxBytes: SEGMENT_CACHE_MAX_BYTES,
        hits: segmentCacheState.hits,
        misses: segmentCacheState.misses,
        hitRatio: cacheHitTotal ? segmentCacheState.hits / cacheHitTotal : 0,
        logicalKeyHits: segmentCacheState.logicalKeyHits,
        hashKeyHits: segmentCacheState.hashKeyHits,
        prefetchCount: segmentCacheState.prefetchCount,
        prefetchQueueDepth: segmentCachePrefetchQueue.length + segmentCachePrefetchActive,
        coalescedRequests: segmentCacheState.coalescedRequests,
        integrityFailures: segmentCacheState.integrityFailures,
        retryCount: segmentCacheState.retryCount,
        evictionCount: segmentCacheState.evictionCount,
        cacheUtilizationPercent: getSegmentCacheUtilizationPercent(),
      },
      activeProxyConnections: metricsState.activeProxyConnections,
      totalBytesServed: metricsState.totalBytesServed,
    },
    player: playerMetrics,
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

function broadcastQueue() {
  broadcast({ type: "queueUpdated", queue: listQueue() });
}

function broadcastPlaylists() {
  broadcast({ type: "playlistsUpdated", playlists: listPlaylists() });
}

function updateState(patch) {
  Object.assign(state, patch);
}

// --- yt-dlp resolver -------------------------------------------------

// Cap total bitrate at 4800k — this still allows typical 1080p30 sources while
// keeping segment size and Canvas 2D presentation load inside the tested range.
const FORMAT_SELECTOR = "bv[vcodec^=avc1][tbr<=4800]+ba[acodec^=mp4a]/bv[vcodec^=avc1][tbr<=4800]+ba*/bv[tbr<=4800]+ba*/b*";

// Common yt-dlp flags — use browser cookies to avoid 429 rate limiting
const YTDLP_COMMON = ["--cookies-from-browser", "chrome"];

function ytdlpJson(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      [
        ...YTDLP_COMMON,
        "--no-warnings", "-j", "--no-playlist",
        "--write-sub", "--sub-lang", "all",
        "-f", FORMAT_SELECTOR,
        url,
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error("Failed to parse yt-dlp output")); }
      }
    );
  });
}

function ytdlpFlatPlaylist(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      [
        ...YTDLP_COMMON,
        "--no-warnings", "--flat-playlist", "--dump-single-json",
        url,
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error("Failed to parse yt-dlp playlist output")); }
      }
    );
  });
}

function playlistEntryUrl(entry) {
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  const extractor = String(entry.ie_key || entry.extractor_key || "").toLowerCase();
  if (extractor.includes("youtube") && entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  if (entry.url) return entry.url;
  return null;
}

function srtToVtt(srt) {
  return "WEBVTT\n\n" + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}

function extractSubtitles(info) {
  const subs = [];
  const manualLangs = new Set();
  // Manual subtitles first (higher quality)
  for (const [lang, formats] of Object.entries(info.subtitles || {})) {
    if (lang === "danmaku") continue;
    // Prefer VTT with URL, then SRT with URL, then any with inline data
    const vtt = formats.find((f) => f.ext === "vtt" && f.url);
    const srt = formats.find((f) => f.ext === "srt" && (f.url || f.data));
    const pick = vtt || srt || formats.find((f) => f.data);
    if (!pick) continue;
    manualLangs.add(lang);
    subs.push({
      lang, name: pick.name || lang, auto: false,
      url: pick.url || null,
      data: pick.data ? (pick.ext === "srt" ? srtToVtt(pick.data) : pick.data) : null,
      ext: pick.ext,
    });
  }
  // Auto-generated — use different key if manual exists for same lang
  for (const [lang, formats] of Object.entries(info.automatic_captions || {})) {
    if (lang.includes("-")) continue;
    const vtt = formats.find((f) => f.ext === "vtt" && f.url);
    const srt = formats.find((f) => f.ext === "srt" && (f.url || f.data));
    const pick = vtt || srt || formats.find((f) => f.data);
    if (!pick) continue;
    const key = manualLangs.has(lang) ? `${lang}-auto` : lang;
    subs.push({
      lang: key, name: `${pick.name || lang} (auto)`, auto: true,
      url: pick.url || null,
      data: pick.data ? (pick.ext === "srt" ? srtToVtt(pick.data) : pick.data) : null,
      ext: pick.ext,
    });
  }
  return subs;
}

function ytdlp(url) {
  return ytdlpJson(url).then((info) => {
    const isLive = !!info.is_live;
    const meta = {
      title: info.title || info.fulltitle || url,
      isLive,
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      uploader: info.uploader || null,
      subtitles: extractSubtitles(info),
    };

    // 1. HLS manifest available — best case
    if (info.manifest_url) {
      return { ...meta, url: info.manifest_url, type: "hls" };
    }

    // 2. Single URL with both audio+video (e.g. YouTube combined format)
    if (info.url) {
      const hasVideo = info.vcodec && info.vcodec !== "none";
      const hasAudio = info.acodec && info.acodec !== "none";
      if (hasVideo && hasAudio) {
        return { ...meta, url: info.url, type: "direct" };
      }
    }

    // 3. Separate video + audio streams (YouTube/Bilibili DASH)
    const rf = info.requested_formats || [];
    if (rf.length >= 2) {
      const video = rf.find((f) => f.vcodec && f.vcodec !== "none");
      const audio = rf.find((f) => f.acodec && f.acodec !== "none");
      if (video && audio) {
        return {
          ...meta,
          videoUrl: video.url, audioUrl: audio.url,
          videoHeaders: video.http_headers || null,
          audioHeaders: audio.http_headers || null,
          videoFormat: video, audioFormat: audio,
          type: "dash_split",
        };
      }
    }

    // 4. Fallback: pick best single format
    if (info.url) {
      return { ...meta, url: info.url, type: "direct" };
    }
    if (info.formats?.length) {
      const best =
        info.formats.find((f) => f.ext === "mp4" && f.vcodec !== "none" && f.acodec !== "none") ||
        info.formats[info.formats.length - 1];
      return { ...meta, url: best.url || best.manifest_url, type: "direct" };
    }

    throw new Error("No playable URL found");
  });
}

// --- ffmpeg muxer (merge video + audio → HLS) ------------------------

const hlsBase = resolve(__dirname, "../.hls-cache");
mkdirSync(hlsBase, { recursive: true });
// Clean leftover HLS sessions from previous runs
for (const d of readdirSync(hlsBase)) {
  rmSync(resolve(hlsBase, d), { recursive: true, force: true });
}

let ffmpegProc = null;
let ytdlpProc = null;
let currentHlsDir = null;
let currentTranscodeDir = null;
const DASH_TRANSCODE = ["1", "true", "yes", "on"]
  .includes(String(process.env.DASH_TRANSCODE ?? "").trim().toLowerCase());
const DASH_TRANSCODE_STARTUP_TIMEOUT_MS = 18_000;

let transcodeState = {
  sessionId: null,
  startedAt: null,
  videoUrl: null,
  audioUrl: null,
  readyAt: null,
  segmentCount: 0,
  readyCheckTimer: null,
  errors: [],
};

function normalizeHeaderValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.filter(Boolean).map((v) => String(v).trim()).join("; ");
  return String(value).trim();
}

function normalizeHeaders(headers) {
  const normalized = {};
  if (!headers || typeof headers !== "object") return normalized;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (!rawName) continue;
    const name = String(rawName).trim();
    const value = normalizeHeaderValue(rawValue);
    if (!name || !value) continue;
    normalized[name] = value;
  }
  return normalized;
}

function hasHeader(normalizedHeaders, targetName) {
  const key = targetName.toLowerCase();
  return Object.keys(normalizedHeaders).some((k) => k.toLowerCase() === key);
}

function setHeaderIfMissing(normalizedHeaders, targetName, value) {
  if (!hasHeader(normalizedHeaders, targetName)) {
    normalizedHeaders[targetName] = value;
  }
}

function buildFfmpegHeadersArg(url, sourceHeaders) {
  const headers = normalizeHeaders(sourceHeaders);
  if (/googlevideo\.com/.test(url || "")) {
    setHeaderIfMissing(headers, "Referer", "https://www.youtube.com/");
    setHeaderIfMissing(headers, "Origin", "https://www.youtube.com");
  }
  if (/bilivideo\.com/.test(url || "")) {
    setHeaderIfMissing(headers, "Referer", "https://www.bilibili.com/");
  }
  setHeaderIfMissing(headers, "User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
  setHeaderIfMissing(headers, "Accept", "*/*");
  setHeaderIfMissing(headers, "Accept-Language", "en-US,en;q=0.8");

  const headerLines = Object.entries(headers)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  return headerLines ? `${headerLines}\r\n` : null;
}

function resetTranscodeState() {
  if (transcodeState.readyCheckTimer) {
    clearInterval(transcodeState.readyCheckTimer);
  }
  transcodeState = {
    sessionId: null,
    startedAt: null,
    videoUrl: null,
    audioUrl: null,
    readyAt: null,
    segmentCount: 0,
    readyCheckTimer: null,
    errors: [],
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function countTranscodeSegments(dir) {
  try {
    return readdirSync(dir).filter((file) => /\.m4s$/i.test(file)).length;
  } catch {
    return 0;
  }
}

function isTranscodeStartupReady(dir) {
  const playlistPath = resolve(dir, "playlist.m3u8");
  const initPath = resolve(dir, "init.mp4");
  if (!existsSync(playlistPath) || !existsSync(initPath)) return false;
  return countTranscodeSegments(dir) >= 2;
}

async function waitForTranscodePlaylist(playlistPath, { timeoutMs = DASH_TRANSCODE_STARTUP_TIMEOUT_MS, pollMs = 120 } = {}) {
  const dir = dirname(playlistPath);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isTranscodeStartupReady(dir)) {
      try {
        const body = readFileSync(playlistPath, "utf-8");
        if (body.includes("#EXTM3U") && body.includes("init.mp4") && body.includes(".m4s")) {
          return { ready: true, body, segmentCount: countTranscodeSegments(dir) };
        }
      } catch {}
    }
    if (!transcodeState.process && !existsSync(playlistPath)) {
      return { ready: false, timedOut: true };
    }
    await sleep(pollMs);
  }
  return { ready: false, timedOut: true };
}

function getCurrentTranscodeSnapshot() {
  return {
    process: ffmpegProc,
    hlsDir: currentHlsDir,
    transcodeDir: currentTranscodeDir,
    state: transcodeState,
  };
}

async function stopTranscodeSnapshot(snapshot, { clearCurrentRefs = false, timeoutMs = 5000 } = {}) {
  if (!snapshot) return;

  const { process: proc, hlsDir, transcodeDir, state } = snapshot;

  if (state?.readyCheckTimer) {
    clearInterval(state.readyCheckTimer);
    state.readyCheckTimer = null;
  }

  if (proc && proc.exitCode == null && proc.signalCode == null) {
    let exited = false;
    const exitPromise = new Promise((resolve) => {
      const finish = () => {
        if (exited) return;
        exited = true;
        resolve();
      };
      proc.once("close", finish);
      proc.once("error", finish);
    });

    try { proc.kill("SIGTERM"); } catch {}
    await Promise.race([exitPromise, sleep(timeoutMs)]);
    if (!exited && proc.exitCode == null && proc.signalCode == null) {
      try { proc.kill("SIGKILL"); } catch {}
      await Promise.race([exitPromise, sleep(2000)]);
    }
  }

  const dirToClean = hlsDir || transcodeDir;
  if (dirToClean) {
    try { rmSync(dirToClean, { recursive: true, force: true }); } catch {}
  }

  if (clearCurrentRefs) {
    if (ffmpegProc === proc) ffmpegProc = null;
    if (currentHlsDir === hlsDir) currentHlsDir = null;
    if (currentTranscodeDir === transcodeDir) currentTranscodeDir = null;
    if (transcodeState === state) resetTranscodeState();
  }
}

function startTranscodePipeline(videoUrl, audioUrl, { videoHeaders = null, audioHeaders = null } = {}) {
  const previousPipeline = getCurrentTranscodeSnapshot();

  const sessionId = `t-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const transcodeDir = resolve(hlsBase, sessionId);
  mkdirSync(transcodeDir, { recursive: true });
  const playlistPath = resolve(transcodeDir, "playlist.m3u8");
  const initFilename = "init.mp4";
  const pipelineState = {
    sessionId,
    startedAt: Date.now(),
    videoUrl,
    audioUrl,
    readyAt: null,
    segmentCount: 0,
    readyCheckTimer: null,
    errors: [],
    process: null,
  };

  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "info",
    ...(buildFfmpegHeadersArg(videoUrl, videoHeaders) ? ["-headers", buildFfmpegHeadersArg(videoUrl, videoHeaders)] : []),
    "-i", videoUrl,
    ...(buildFfmpegHeadersArg(audioUrl, audioHeaders) ? ["-headers", buildFfmpegHeadersArg(audioUrl, audioHeaders)] : []),
    "-i", audioUrl,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast",
    "-profile:v", "main", "-level", "4.0", "-crf", "23",
    "-maxrate", "4800k", "-bufsize", "9600k",
    "-c:a", "aac", "-b:a", "192k",
    "-f", "hls",
    "-hls_time", "6",
    "-hls_list_size", "0",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", initFilename,
    "-hls_segment_filename", resolve(transcodeDir, "seg%d.m4s"),
    playlistPath,
  ];

  log.info({ sessionId, url: truncateUrl(videoUrl, 200), urlAudio: truncateUrl(audioUrl, 200) }, "Starting DASH split transcoding pipeline");

  let proc;
  try {
    proc = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    rmSync(transcodeDir, { recursive: true, force: true });
    throw new Error(`Failed to launch ffmpeg: ${error.message}`);
  }

  pipelineState.process = proc;
  ffmpegProc = proc;
  currentHlsDir = transcodeDir;
  currentTranscodeDir = transcodeDir;
  transcodeState = pipelineState;

  const onProgressLine = (line) => {
    const segmentMatch = line.match(/Opening ["']([^"']*\.m4s)["']/i);
    if (segmentMatch) {
      pipelineState.segmentCount += 1;
      log.info({
        sessionId,
        segment: segmentMatch[1].split("/").at(-1),
        segmentIndex: pipelineState.segmentCount,
      }, "Transcode segment generated");
      return;
    }

    if (line.includes("frame=")) {
      const frameMatch = line.match(/frame=\s*(\d+)\s*time=([^\s]+)/);
      const progress = frameMatch ? { frame: Number(frameMatch[1]), time: frameMatch[2] } : { rawLine: line.trim() };
      log.debug({ sessionId, ...progress }, "Transcode progress");
    }

    if (line.toLowerCase().includes("error") || line.toLowerCase().includes("failed")) {
      log.error({ sessionId, line: line.trim() }, "Transcode stderr");
    }
  };

  proc.stderr.on("data", (chunk) => {
    const payload = chunk.toString("utf-8");
    for (const line of payload.split(/\r?\n/)) {
      if (!line) continue;
      onProgressLine(line);
    }
  });

  proc.on("error", (error) => {
    pipelineState.errors.push(error.message || String(error));
    log.error({ sessionId, err: error.message }, "DASH transcode process spawn error");
  });

  proc.on("close", (code, signal) => {
    if (!pipelineState.readyAt && code !== 0) {
      log.error({ sessionId, exitCode: code, signal }, "DASH transcode process exited before playback ready");
      if (code === null && signal === "SIGTERM") {
        log.info({ sessionId }, "DASH transcode process stopped");
      }
    }
    if (pipelineState.readyAt) {
      log.info({ sessionId, exitCode: code, signal }, "DASH transcode process finished");
    }
    if (ffmpegProc === proc) ffmpegProc = null;
    if (transcodeState === pipelineState) transcodeState.process = null;
    if (pipelineState.readyCheckTimer) {
      clearInterval(pipelineState.readyCheckTimer);
      pipelineState.readyCheckTimer = null;
    }
  });

  const readyCheck = async () => {
    if (!pipelineState.process) return;
    if (pipelineState.readyAt) return;
    if (isTranscodeStartupReady(transcodeDir)) {
      pipelineState.readyAt = Date.now();
      if (pipelineState.readyCheckTimer) {
        clearInterval(pipelineState.readyCheckTimer);
        pipelineState.readyCheckTimer = null;
      }
      log.info({ sessionId }, "DASH transcode is ready for playback");
    }
  };
  pipelineState.readyCheckTimer = setInterval(readyCheck, 250);
  pipelineState.readyCheckTimer.unref();

  if (previousPipeline.process || previousPipeline.hlsDir || previousPipeline.transcodeDir) {
    void stopTranscodeSnapshot(previousPipeline).catch((error) => {
      log.warn({ err: error?.message || String(error) }, "Failed to stop previous DASH transcode");
    });
  }

  return {
    sessionId,
    sessionDir: transcodeDir,
    playlistPath,
    process: proc,
  };
}

async function killPipeline() {
  const snapshot = getCurrentTranscodeSnapshot();
  if (!snapshot.process && !snapshot.hlsDir && !snapshot.transcodeDir) {
    resetTranscodeState();
    currentHlsDir = null;
    currentTranscodeDir = null;
    ffmpegProc = null;
    return;
  }
  await stopTranscodeSnapshot(snapshot, { clearCurrentRefs: true });
}

function getTranscodeSession() {
  if (!currentTranscodeDir) return null;
  const playlistPath = resolve(currentTranscodeDir, "playlist.m3u8");
  if (!existsSync(playlistPath)) return null;
  return {
    sessionId: transcodeState.sessionId,
    sessionDir: currentTranscodeDir,
    playlistPath,
    process: transcodeState.process,
  };
}

// --- Media cache (thumbnails + subtitles) ----------------------------

const CACHE_DIR = resolve(__dirname, "../.media-cache");
const SUBS_CACHE_DIR = resolve(CACHE_DIR, "subs");
const THUMB_CACHE_DIR = resolve(CACHE_DIR, "thumbs");
mkdirSync(SUBS_CACHE_DIR, { recursive: true });
mkdirSync(THUMB_CACHE_DIR, { recursive: true });

// Get a stable cache key from URL (video ID or hash)
function subsCacheKey(url) {
  // Extract video ID for known platforms
  const ytMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  if (ytMatch) return ytMatch[1];
  const bvMatch = url.match(/(BV[\w]+)/);
  if (bvMatch) return bvMatch[1];
  // Fallback: simple hash
  let h = 0;
  for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  return "h" + Math.abs(h).toString(36);
}

function getCachedSubs(url) {
  const dir = resolve(SUBS_CACHE_DIR, subsCacheKey(url));
  if (!existsSync(dir)) return null;
  const results = [];
  for (const f of readdirSync(dir)) {
    const match = f.match(/^sub_(.+)\.vtt$/);
    if (match) results.push({ lang: match[1], name: match[1], auto: match[1].includes("-auto"), filename: f, cached: true });
  }
  return results.length ? { dir, subs: results } : null;
}

// --- Subtitle download (direct fetch from URLs in yt-dlp JSON) ------

async function downloadSubtitlesDirect(subtitleList, destDir) {
  mkdirSync(destDir, { recursive: true });
  const results = [];
  for (const sub of subtitleList) {
    try {
      let content;

      if (sub.data) {
        // Inline data (Bilibili etc) — already converted to VTT
        content = sub.data;
      } else if (sub.url) {
        const resp = await fetch(sub.url);
        if (!resp.ok) {
          log.warn({ lang: sub.lang, status: resp.status }, "Subtitle fetch failed");
          continue;
        }
        content = await resp.text();

        // YouTube returns HLS playlist for long videos — fetch all segments
        if (content.startsWith("#EXTM3U")) {
          const segUrls = content.split("\n").filter((l) => l.startsWith("http"));
          const parts = [];
          for (const segUrl of segUrls) {
            const segResp = await fetch(segUrl);
            if (segResp.ok) parts.push(await segResp.text());
          }
          content = parts.map((p, i) => {
            if (i === 0) return p;
            return p.replace(/^WEBVTT[\s\S]*?\n\n/, "");
          }).join("\n");
        }

        // SRT → VTT conversion
        if (sub.ext === "srt" && !content.startsWith("WEBVTT")) {
          content = srtToVtt(content);
        }
      } else {
        continue;
      }

      if (!content.includes("-->")) {
        log.warn({ lang: sub.lang }, "No valid subtitle cues");
        continue;
      }

      // Clean VTT: strip cue tags (<c>, timestamp tags) and decode HTML entities
      content = content
        .replace(/<\/?c[^>]*>/g, "")
        .replace(/<[\d:.]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");

      const filename = `sub_${sub.lang}.vtt`;
      writeFileSync(resolve(destDir, filename), content);
      results.push({ lang: sub.lang, name: sub.name, auto: sub.auto, filename });
    } catch (e) {
      log.error({ lang: sub.lang, err: e.message }, "Subtitle fetch error");
    }
  }
  return results;
}

// Serve subtitle VTT files from cache or session dir
app.get("/api/subs/:key/:filename", (req, res) => {
  const dir = resolve(SUBS_CACHE_DIR, req.params.key);
  const filePath = resolve(dir, req.params.filename);
  if (!filePath.startsWith(dir) || !existsSync(filePath)) {
    return res.status(404).json({ error: "Subtitle not found" });
  }
  res.set("Content-Type", "text/vtt");
  res.set("Access-Control-Allow-Origin", "*");
  res.sendFile(filePath, { dotfiles: "allow" });
});

// List subtitles for current non-Plex content
app.get("/api/subtitles", (req, res) => {
  res.json(currentSubtitles.map((s) => ({
    lang: s.lang,
    name: s.name,
    auto: s.auto,
    url: s.filename && currentSubsCacheKey ? `/api/subs/${currentSubsCacheKey}/${s.filename}` : null,
  })));
});

// Select subtitle — tell player to load it
app.post("/api/subtitles/select", (req, res) => {
  const { lang } = req.body;
  if (!lang) {
    // Disable subtitles
    broadcast({ type: "subtitleSelect", url: null, lang: null });
    return res.json({ ok: true, lang: null });
  }
  if (!currentSubtitles.length) return res.status(400).json({ error: "No video playing or no subtitles available" });
  const sub = currentSubtitles.find((s) => s.lang === lang);
  if (!sub?.filename || !currentSubsCacheKey) {
    const available = currentSubtitles.map((s) => s.lang).join(", ");
    return res.status(404).json({ error: `Subtitle '${lang}' not found. Available: ${available}` });
  }
  const url = `/api/subs/${currentSubsCacheKey}/${sub.filename}`;
  // Notify player to load the subtitle
  broadcast({ type: "subtitleSelect", url, lang: sub.lang, name: sub.name });
  res.json({ ok: true, lang: sub.lang, name: sub.name, url });
});

// Serve HLS cache files (dynamic directory per session)
let hlsMiddleware = null;
let hlsMiddlewareDir = null;
app.use("/api/hls", (req, res, next) => {
  if (!currentHlsDir) return res.status(404).json({ error: "No active stream" });
  if (currentHlsDir !== hlsMiddlewareDir) {
    hlsMiddlewareDir = currentHlsDir;
    hlsMiddleware = express.static(currentHlsDir, {
      setHeaders: (res) => {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Cache-Control", "no-cache");
      },
    });
  }
  hlsMiddleware(req, res, next);
});

function rewriteTranscodePlaylist(body) {
  const manifestBasePath = "/api/transcode";
  return body.replace(/^(?!#)(\S+.*)$/gm, (match, line) => {
    const trimmed = line.trim();
    if (!trimmed) return match;
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    const segmentName = trimmed.split("?")[0];
    if (!segmentName) return match;
    const safeSegmentName = segmentName.replace(/[\\/]+/g, "").replace(/^\.+/g, "");
    return `${manifestBasePath}/segment?name=${encodeURIComponent(safeSegmentName)}`;
  });
}

app.get("/api/transcode/playlist.m3u8", async (req, res) => {
  const session = getTranscodeSession();
  if (!session) return res.status(404).json({ error: "No active transcode session" });
  const ready = await waitForTranscodePlaylist(session.playlistPath, { timeoutMs: DASH_TRANSCODE_STARTUP_TIMEOUT_MS, pollMs: 120 });
  if (!ready.ready) {
    return res.status(503).json({
      error: transcodeState.process ? "Transcode still starting" : "Transcode pipeline unavailable",
      ready: false,
    });
  }
  let body = ready.body;
  if (typeof body !== "string") {
    try { body = readFileSync(session.playlistPath, "utf-8"); } catch { body = ""; }
  }
  if (!body) return res.status(503).json({ error: "Invalid transcode playlist" });
  res.set("Content-Type", "application/vnd.apple.mpegurl");
  res.set("Access-Control-Allow-Origin", "*");
  res.send(rewriteTranscodePlaylist(body));
});

app.get("/api/transcode/segment", (req, res) => {
  const session = getTranscodeSession();
  if (!session) return res.status(404).json({ error: "No active transcode session" });
  const name = req.query.name ? String(req.query.name) : "";
  if (!name || !/^(?:init\.mp4|[A-Za-z0-9._-]+\.m4s)$/i.test(name)) {
    return res.status(400).json({ error: "Invalid segment name" });
  }
  const safeName = name;
  const filePath = resolve(session.sessionDir, safeName);
  if (!existsSync(filePath)) return res.status(404).json({ error: "Segment not found" });
  res.set("Content-Type", "video/mp4");
  res.set("Cache-Control", "no-cache");
  res.sendFile(filePath, { dotfiles: "allow" });
});

// --- fMP4 HLS generation (for YouTube/Bilibili split streams) --------

// Keep each generated playlist addressable by its own session ID. A browser can
// briefly overlap two play requests while reconnecting; a global playlist would
// make the newer request invalidate segments still needed by the older player.
const dashHlsSessions = new Map();

// Probe MP4 structure: find init segment end, parse sidx for segment byte ranges
async function probeMP4Structure(proxyId) {
  // Fetch first 128KB — should contain ftyp + moov + sidx
  const resp = await fetchWithRetry(
    `http://localhost:${PORT}/api/proxy?id=${proxyId}`,
    { headers: { Range: "bytes=0-131071" } },
    { retries: 3, label: "dash-probe" },
  );
  const buf = Buffer.from(await resp.arrayBuffer());
  const totalSize = parseInt((resp.headers.get("content-range") || "").split("/")[1] || "0");

  let initEnd = 0;
  let sidxOffset = -1;
  let mdatOffset = 0;
  let pos = 0;

  // Find top-level boxes
  while (pos < buf.length - 8) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (size < 8) break;

    if (type === "moov") initEnd = pos + size - 1;
    else if (type === "sidx") sidxOffset = pos;
    else if (type === "mdat") { mdatOffset = pos; break; }
    pos += size;
  }

  // Parse sidx to extract segment byte ranges
  const segments = [];
  let timescale = 1000;
  if (sidxOffset >= 0 && sidxOffset + 12 < buf.length) {
    const sidxSize = buf.readUInt32BE(sidxOffset);
    const version = buf[sidxOffset + 8];
    let off = sidxOffset + 12;
    // reference_ID (4) + timescale (4)
    off += 4; // reference_ID
    timescale = buf.readUInt32BE(off); off += 4;
    // earliest_presentation_time + first_offset
    let firstOffset = 0;
    if (version === 0) {
      off += 4; // earliest_presentation_time
      firstOffset = buf.readUInt32BE(off); off += 4;
    } else {
      off += 8; // earliest_presentation_time
      firstOffset = Number(buf.readBigUInt64BE(off)); off += 8;
    }
    // reserved (2) + reference_count (2)
    off += 2;
    const referenceCount = buf.readUInt16BE(off); off += 2;

    let segStart = sidxOffset + sidxSize + firstOffset;
    for (let i = 0; i < referenceCount && off + 12 <= buf.length; i++) {
      const firstWord = buf.readUInt32BE(off);
      const referenceType = firstWord >>> 31;
      if (referenceType === 1) break; // nested sidx not supported here
      const referencedSize = firstWord & 0x7FFFFFFF;
      const subsegDuration = buf.readUInt32BE(off + 4);
      segments.push({
        start: segStart,
        end: segStart + referencedSize - 1,
        duration: subsegDuration / timescale,
        durationTicks: subsegDuration,
      });
      segStart += referencedSize;
      off += 12;
    }
  }

  return { initEnd, segments, totalSize, timescale };
}

function generateDashHls(sessionId, videoFormat, audioFormat, videoProxyId, audioProxyId, videoInfo, audioInfo) {
  if (!videoInfo.segments.length || !audioInfo.segments.length) return null;

  const videoMapId = `seg-${videoProxyId}`;
  const audioMapId = `seg-${audioProxyId}`;
  dashSegmentMaps.set(videoMapId, {
    proxyId: videoProxyId,
    initEnd: videoInfo.initEnd,
    segments: videoInfo.segments,
    createdAt: Date.now(),
  });
  dashSegmentMaps.set(audioMapId, {
    proxyId: audioProxyId,
    initEnd: audioInfo.initEnd,
    segments: audioInfo.segments,
    createdAt: Date.now(),
  });
  const videoCodec = videoFormat.vcodec || "avc1.640028";
  const audioCodec = audioFormat.acodec || "mp4a.40.2";
  const videoBandwidth = Math.round((videoFormat.tbr || 2000) * 1000);
  const audioBandwidth = Math.round((audioFormat.tbr || 128) * 1000);
  const width = videoFormat.width || 1920;
  const height = videoFormat.height || 1080;
  const fps = videoFormat.fps || 30;

  const mediaPlaylist = (mapId, segments) => {
    const targetDuration = Math.max(1, Math.ceil(Math.max(...segments.map((segment) => segment.duration))));
    const body = segments.flatMap((segment, index) => [
      `#EXTINF:${segment.duration.toFixed(6)},`,
      `/api/dash/${mapId}/${index}.mp4`,
    ]).join("\n");
    return `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="/api/dash/${mapId}/init.mp4"
${body}
#EXT-X-ENDLIST
`;
  };

  const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="/api/dash/hls/${sessionId}/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=${videoBandwidth + audioBandwidth},RESOLUTION=${width}x${height},FRAME-RATE=${fps},CODECS="${videoCodec},${audioCodec}",AUDIO="audio"
/api/dash/hls/${sessionId}/video.m3u8
`;

  return {
    master,
    video: mediaPlaylist(videoMapId, videoInfo.segments),
    audio: mediaPlaylist(audioMapId, audioInfo.segments),
  };
}

// DASH segment maps: mapId → { proxyId, initEnd, segments: [{start,end,duration}] }
const dashSegmentMaps = new Map();
let dashPlaybackGeneration = 0;

function resetDashSegmentSession() {
  dashPlaybackGeneration += 1;
  segmentCachePrefetchQueue.length = 0;
  segmentCachePrefetchSet.clear();
  pruneDashSessions();
}

function pruneDashSessions(now = Date.now()) {
  for (const [mapId, map] of dashSegmentMaps) {
    if (now - (map.lastAccessAt || map.createdAt) > PROXY_TTL_MS) dashSegmentMaps.delete(mapId);
  }
  for (const [sessionId, session] of dashHlsSessions) {
    if (now - (session.lastAccessAt || session.createdAt) > PROXY_TTL_MS) dashHlsSessions.delete(sessionId);
  }
}

app.get("/api/dash/hls/:sessionId/:playlist", (req, res) => {
  const session = dashHlsSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Unknown HLS session" });
  session.lastAccessAt = Date.now();
  const playlistName = String(req.params.playlist || "").replace(/\.m3u8$/i, "");
  const body = session[playlistName];
  if (!body) return res.status(404).json({ error: "Unknown HLS playlist" });
  res.set("Content-Type", "application/vnd.apple.mpegurl");
  res.set("Cache-Control", "no-cache");
  res.set("Access-Control-Allow-Origin", "*");
  res.send(body);
});

// Serve DASH segments: /api/dash/:mapId/init.mp4 or /api/dash/:mapId/:number.mp4
app.get("/api/dash/:mapId/:segment", async (req, res) => {
  const map = dashSegmentMaps.get(req.params.mapId);
  if (!map) return res.status(404).json({ error: "Unknown segment map" });
  map.lastAccessAt = Date.now();
  const metric = beginProxyMetric("/api/dash/:mapId/:segment");
  trackProxyMetricLifecycle(res, metric);

  let rangeStr;
  let segmentIndex = null;
  const segName = req.params.segment.replace(".mp4", "");
  if (segName === "init") {
    rangeStr = `bytes=0-${map.initEnd}`;
  } else {
    const idx = parseInt(segName);
    if (isNaN(idx) || idx < 0) {
      return res.status(404).json({ error: "Segment not found" });
    }
    // Clamp to last segment if index is past end (rounding mismatch)
    segmentIndex = Math.min(idx, map.segments.length - 1);
    const seg = map.segments[segmentIndex];
    rangeStr = `bytes=${seg.start}-${seg.end}`;
  }

  try {
    const entry = proxyMap.get(map.proxyId);
    if (!entry) return res.status(404).json({ error: "Proxy expired" });
    const cacheEntry = getSegmentCacheEntry(entry.url, rangeStr, entry);
    if (cacheEntry) {
      segmentCacheState.hits += 1;
      if (cacheEntry.kind === "hash") segmentCacheState.hashKeyHits += 1;
      else segmentCacheState.logicalKeyHits += 1;
      logSegmentCacheHit({ cacheKey: cacheEntry, cacheEntry, proxyId: map.proxyId, rangeHeader: rangeStr });
      await serveSegmentCacheToResponse(
        cacheEntry,
        res,
        (bytes) => recordProxyMetricBytes(metric, bytes),
        { statusOverride: 200, includeRangeHeaders: false },
      );
      if (segmentIndex !== null) {
        for (let offset = 1; offset <= SEGMENT_PREFETCH_AHEAD; offset++) {
          const next = map.segments[segmentIndex + offset];
          if (!next) break;
          enqueueSegmentPrefetch(map.proxyId, `bytes=${next.start}-${next.end}`, segmentIndex + offset);
        }
      }
      return;
    }

    segmentCacheState.misses += 1;
    logSegmentCacheMiss({
      cacheKey: getSegmentCachePaths(entry.url, rangeStr, entry),
      proxyId: map.proxyId,
      upstreamUrl: entry.url,
      rangeHeader: rangeStr,
    });
    const result = await getOrFetchDashSegment(map.proxyId, rangeStr, { label: "dash-seg" });
    if (req.destroyed || res.destroyed) return;
    if (result.cacheEntry) {
      await serveSegmentCacheToResponse(
        result.cacheEntry,
        res,
        (bytes) => recordProxyMetricBytes(metric, bytes),
        { statusOverride: 200, includeRangeHeaders: false },
      );
    } else {
      serveDashSegmentBuffer(result, res, (bytes) => recordProxyMetricBytes(metric, bytes));
    }
    if (segmentIndex !== null) {
      for (let offset = 1; offset <= SEGMENT_PREFETCH_AHEAD; offset++) {
        const next = map.segments[segmentIndex + offset];
        if (!next) break;
        enqueueSegmentPrefetch(map.proxyId, `bytes=${next.start}-${next.end}`, segmentIndex + offset);
      }
    }
  } catch (e) {
    if (metric) metric.error = e.message || String(e);
    if (!res.headersSent && !(isAbortLikeError(e) && (req.destroyed || res.destroyed))) {
      res.status(502).json({ error: e.message });
    }
  }
});

// --- Stream proxy (bypass CORS) --------------------------------------

// Store resolved URLs for proxy lookup (with TTL cleanup)
const proxyMap = new Map();
setInterval(() => {
  const now = Date.now();
  let removedExpired = 0;
  for (const [k, v] of proxyMap) {
    if (now - (v.lastAccessAt || v.createdAt || now) > PROXY_TTL_MS) {
      proxyMap.delete(k);
      removedExpired++;
    }
  }
  let oldestEntryAgeMs = 0;
  for (const entry of proxyMap.values()) {
    oldestEntryAgeMs = Math.max(oldestEntryAgeMs, proxyEntryAgeMs(entry, now) || 0);
  }
  log.info({
    proxyMapSize: proxyMap.size,
    oldestEntryAgeMs,
    totalBytesServed: metricsState.totalBytesServed,
    removedExpired,
  }, "Proxy map health");
  pruneDashSessions(now);
}, 60_000).unref();

function proxyRegister(url, headers = null, meta = {}) {
  const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const registeredUrl = snapshotProxyUrl(url);
  const originalUrl = meta.originalUrl ? snapshotProxyUrl(meta.originalUrl) : null;
  proxyMap.set(id, {
    url,
    headers,
    createdAt: now,
    lastAccessAt: now,
    expiresAt: parseProxyUrlExpiry(url),
    registeredUrlHost: registeredUrl.host,
    registeredUrlPathname: registeredUrl.pathname,
    registeredUrlParams: registeredUrl.params,
    originalUrlHost: originalUrl?.host || registeredUrl.host,
    originalUrlPathname: originalUrl?.pathname || registeredUrl.pathname,
    originalUrlParams: originalUrl?.params || registeredUrl.params,
    ...meta,
  });
  return id;
}

function parseProxyUrlExpiry(url) {
  try {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get("expire")
      || parsed.searchParams.get("expires")
      || parsed.searchParams.get("deadline");
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  } catch {
    return null;
  }
}

function touchProxyEntry(entry) {
  if (entry) entry.lastAccessAt = Date.now();
}

function getProxyExpiryState(entry, now = Date.now()) {
  const expiresAt = entry?.expiresAt ?? parseProxyUrlExpiry(entry?.url || "");
  if (!expiresAt) {
    return { expiresAt: null, expiresInMs: null, isExpired: false, needsRefresh: false };
  }
  const expiresInMs = expiresAt - now;
  return {
    expiresAt,
    expiresInMs,
    isExpired: expiresInMs <= 0,
    needsRefresh: expiresInMs <= PROXY_REFRESH_SKEW_MS,
  };
}

function proxyLogMeta(proxyId, entry, extra = {}) {
  const expiry = getProxyExpiryState(entry);
  let upstreamHost = null;
  if (entry?.url) {
    try { upstreamHost = new URL(entry.url).host; } catch {}
  }
  return {
    proxyId,
    role: entry?.role,
    pairId: entry?.pairId,
    upstreamHost,
    urlExpiresAt: expiry.expiresAt,
    urlExpiresInMs: expiry.expiresInMs,
    ...extra,
  };
}

// Re-resolve expired CDN URLs via yt-dlp
const reResolveInProgress = new Map();

async function reResolveProxy(proxyId) {
  const entry = proxyMap.get(proxyId);
  if (!entry?.originalUrl) return false;

  // Deduplicate concurrent re-resolves for same URL
  if (reResolveInProgress.has(entry.originalUrl)) {
    await reResolveInProgress.get(entry.originalUrl);
    return true;
  }

  const promise = (async () => {
    log.info({ url: entry.originalUrl }, "Re-resolving expired CDN URLs");
    const resolved = await ytdlp(entry.originalUrl);
    // Update all proxy entries with matching pairId
    if (entry.pairId && resolved.type === "dash_split") {
      for (const [, e] of proxyMap) {
        if (e.pairId !== entry.pairId) continue;
        if (e.role === "video") { e.url = resolved.videoUrl; e.headers = resolved.videoHeaders; }
        if (e.role === "audio") { e.url = resolved.audioUrl; e.headers = resolved.audioHeaders; }
        e.expiresAt = parseProxyUrlExpiry(e.url);
        touchProxyEntry(e);
      }
    } else if (resolved.url) {
      entry.url = resolved.url;
      entry.expiresAt = parseProxyUrlExpiry(entry.url);
      touchProxyEntry(entry);
    }
    log.info("CDN URLs refreshed");
  })();

  reResolveInProgress.set(entry.originalUrl, promise);
  try { await promise; } finally { reResolveInProgress.delete(entry.originalUrl); }
  return true;
}

function proxyHeaders(entry) {
  // Use yt-dlp's per-format headers if available (includes correct Referer, UA, Accept etc.)
  if (entry.headers) return { ...entry.headers };
  // Fallback with all required headers for CDN anti-hotlink checks
  const h = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-us,en;q=0.5",
    "Sec-Fetch-Mode": "navigate",
  };
  if (entry.url.includes("bilivideo.com")) h["Referer"] = "https://www.bilibili.com/";
  return h;
}

// --- Segment cache (proxied segments + HLS/DASH .ts/.mp4 chunks) ----

const segmentCacheState = {
  sizeBytes: 0,
  hits: 0,
  misses: 0,
  logicalKeyHits: 0,
  hashKeyHits: 0,
  prefetchCount: 0,
  coalescedRequests: 0,
  integrityFailures: 0,
  retryCount: 0,
  evictionCount: 0,
};

const segmentCachePrefetchQueue = [];
const dashSegmentFetches = new Map();
let segmentCachePrefetchActive = 0;
const segmentCachePrefetchSet = new Set();
let segmentCacheEvictionTimer = null;
let lastSegmentCacheEvictionMs = 0;
let segmentCacheHealthSnapshot = {
  hits: 0,
  misses: 0,
};

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try { unlinkSync(filePath); } catch {}
}

function snapshotProxyUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host.toLowerCase(),
      pathname: parsed.pathname || "/",
      params: Object.fromEntries(parsed.searchParams.entries()),
    };
  } catch {
    return {
      host: "",
      pathname: "",
      params: {},
    };
  }
}

function normalizeRangeForCacheKey(rangeHeader = "") {
  const match = String(rangeHeader).match(/^bytes=(\d+)?-(\d+)?$/i);
  return {
    start: match?.[1] || "*",
    end: match?.[2] || "*",
  };
}

function computeCacheKey(upstreamUrl, rangeHeader = "", cacheContext = null) {
  const urlInfo = snapshotProxyUrl(upstreamUrl);
  const hostCandidates = [urlInfo.host, cacheContext?.registeredUrlHost, cacheContext?.originalUrlHost]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  const mergedParams = {
    ...(cacheContext?.registeredUrlParams || {}),
    ...(cacheContext?.originalUrlParams || {}),
    ...urlInfo.params,
  };
  const isYouTubeSource = hostCandidates.some((host) => host.includes("googlevideo.com") || host.includes("youtube.com") || host.includes("youtu.be"));
  if (isYouTubeSource) {
    const required = ["id", "itag", "clen", "lmt"];
    if (required.every((key) => mergedParams[key])) {
      const range = normalizeRangeForCacheKey(rangeHeader);
      const logicalKey = `yt:${mergedParams.id}:${mergedParams.itag}:${mergedParams.clen}:${mergedParams.lmt}:${range.start}-${range.end}`;
      return {
        kind: "logical",
        sourceType: "youtube",
        logicalKey,
        filenameKey: sha256Hex(logicalKey),
      };
    }
  }

  const isBilibiliSource = hostCandidates.some((host) => host.includes("bilivideo.com"));
  if (isBilibiliSource && /\.m4s$/i.test(urlInfo.pathname)) {
    const range = normalizeRangeForCacheKey(rangeHeader);
    const logicalKey = `bili:${urlInfo.pathname}:${range.start}-${range.end}`;
    return {
      kind: "logical",
      sourceType: "bilibili",
      logicalKey,
      filenameKey: sha256Hex(logicalKey),
    };
  }

  const hlsPath = urlInfo.pathname || cacheContext?.registeredUrlPathname || cacheContext?.originalUrlPathname || "";
  if (hlsPath.toLowerCase().endsWith(".ts")) {
    const logicalKey = `hls:${sha256Hex(hlsPath)}`;
    return {
      kind: "logical",
      sourceType: "hls",
      logicalKey,
      filenameKey: sha256Hex(logicalKey),
    };
  }

  const fallbackHash = sha256Hex(`${upstreamUrl}\n${rangeHeader || ""}`);
  return {
    kind: "hash",
    sourceType: "fallback",
    logicalKey: `hash:${fallbackHash}`,
    filenameKey: fallbackHash,
  };
}

function getSegmentCachePaths(upstreamUrl, rangeHeader = "", cacheContext = null) {
  const cacheKey = computeCacheKey(upstreamUrl, rangeHeader, cacheContext);
  return {
    ...cacheKey,
    key: cacheKey.filenameKey,
    dataPath: resolve(SEGMENT_CACHE_DIR, `${cacheKey.filenameKey}.dat`),
    metaPath: resolve(SEGMENT_CACHE_DIR, `${cacheKey.filenameKey}.meta`),
  };
}

function parseSegmentCacheMeta(path) {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

function touchSegmentCacheAccess(dataPath) {
  try {
    const stat = statSync(dataPath);
    utimesSync(dataPath, new Date(), stat.mtime);
  } catch {}
}

function logSegmentCacheError(operation, cacheKey, err, extra = {}) {
  log.warn({
    operation,
    cacheKey: cacheKey?.logicalKey || cacheKey?.filenameKey || null,
    cacheKeyType: cacheKey?.kind || null,
    err: err?.message || String(err),
    ...extra,
  }, "Cache error");
}

function logSegmentCacheHit({ cacheKey, cacheEntry, proxyId, rangeHeader }) {
  log.info({
    cacheKey: cacheKey?.logicalKey || null,
    cacheKeyType: cacheKey?.kind || null,
    fileSizeBytes: cacheEntry?.sizeBytes || 0,
    proxyId: proxyId || null,
    rangeRequested: rangeHeader || null,
  }, "Cache hit");
}

function logSegmentCacheMiss({ cacheKey, proxyId, upstreamUrl, rangeHeader }) {
  log.info({
    cacheKey: cacheKey?.logicalKey || null,
    cacheKeyType: cacheKey?.kind || null,
    upstreamUrl: truncateUrl(upstreamUrl, 80),
    proxyId: proxyId || null,
    rangeRequested: rangeHeader || null,
  }, "Cache miss");
}

function logSegmentCacheWrite({ cacheKey, bytesWritten, writeDurationMs }) {
  log.info({
    cacheKey: cacheKey?.logicalKey || null,
    cacheKeyType: cacheKey?.kind || null,
    bytesWritten,
    writeDurationMs,
  }, "Cache write");
}

function logSegmentCacheEviction({ filesEvicted, bytesFreed, newCacheSizeBytes }) {
  log.info({
    filesEvicted,
    bytesFreed,
    newCacheSizeBytes,
  }, "Cache eviction");
}

function logSegmentPrefetchStart({ cacheKey, segmentIndex }) {
  log.debug({
    cacheKey: cacheKey?.logicalKey || null,
    cacheKeyType: cacheKey?.kind || null,
    segmentIndex,
  }, "Prefetch start");
}

function logSegmentPrefetchComplete({ cacheKey, bytesCached, durationMs }) {
  log.info({
    cacheKey: cacheKey?.logicalKey || null,
    cacheKeyType: cacheKey?.kind || null,
    bytesCached,
    durationMs,
  }, "Prefetch complete");
}

function getCachedSegmentCount() {
  try {
    let count = 0;
    for (const file of readdirSync(SEGMENT_CACHE_DIR)) {
      if (file.endsWith(".meta")) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function getSegmentCacheUtilizationPercent() {
  if (!SEGMENT_CACHE_MAX_BYTES) return 0;
  return Math.min(100, Math.max(0, (segmentCacheState.sizeBytes / SEGMENT_CACHE_MAX_BYTES) * 100));
}

function purgeSegmentCacheCandidate(upstreamUrl, rangeHeader, cacheContext = null) {
  const paths = getSegmentCachePaths(upstreamUrl, rangeHeader || "", cacheContext);
  safeUnlink(paths.dataPath);
  safeUnlink(paths.metaPath);
}

function getSegmentCacheEntry(upstreamUrl, rangeHeader, cacheContext = null) {
  const paths = getSegmentCachePaths(upstreamUrl, rangeHeader || "", cacheContext);
  if (!existsSync(paths.dataPath) || !existsSync(paths.metaPath)) return null;
  try {
    const meta = parseSegmentCacheMeta(paths.metaPath);
    const stat = statSync(paths.dataPath);
    touchSegmentCacheAccess(paths.dataPath);
    return { ...paths, meta, sizeBytes: stat.size };
  } catch (err) {
    logSegmentCacheError("read", paths, err);
    purgeSegmentCacheCandidate(upstreamUrl, rangeHeader || "", cacheContext);
    return null;
  }
}

function initializeSegmentCache() {
  mkdirSync(SEGMENT_CACHE_DIR, { recursive: true });
  let total = 0;
  const files = readdirSync(SEGMENT_CACHE_DIR);
  const validData = new Set();

  for (const file of files) {
    if (!file.endsWith(".dat")) continue;
    const dataPath = resolve(SEGMENT_CACHE_DIR, file);
    const metaPath = resolve(SEGMENT_CACHE_DIR, `${file.slice(0, -4)}.meta`);
    if (!existsSync(metaPath)) {
      safeUnlink(metaPath);
      safeUnlink(dataPath);
      continue;
    }
    try {
      const stat = statSync(dataPath);
      total += stat.size;
      validData.add(file);
    } catch {
      safeUnlink(dataPath);
      safeUnlink(metaPath);
    }
  }

  for (const file of files) {
    if (!file.endsWith(".meta")) continue;
    const base = file.slice(0, -5);
    const dataPath = resolve(SEGMENT_CACHE_DIR, `${base}.dat`);
    if (!validData.has(`${base}.dat`)) {
      safeUnlink(dataPath);
      safeUnlink(resolve(SEGMENT_CACHE_DIR, file));
    }
  }

  segmentCacheState.sizeBytes = total;
  log.info({ path: SEGMENT_CACHE_DIR, sizeBytes: segmentCacheState.sizeBytes }, "Segment cache initialized");
}

setInterval(() => {
  const hitsSinceLast = segmentCacheState.hits - segmentCacheHealthSnapshot.hits;
  const missesSinceLast = segmentCacheState.misses - segmentCacheHealthSnapshot.misses;
  const totalSinceLast = hitsSinceLast + missesSinceLast;
  segmentCacheHealthSnapshot = {
    hits: segmentCacheState.hits,
    misses: segmentCacheState.misses,
  };
  log.info({
    totalCacheSizeMB: segmentCacheState.sizeBytes / (1024 * 1024),
    maxCacheSizeMB: SEGMENT_CACHE_MAX_BYTES / (1024 * 1024),
    cacheUtilizationPercent: getSegmentCacheUtilizationPercent(),
    hitRatioSinceLastHealthLog: totalSinceLast ? hitsSinceLast / totalSinceLast : 0,
    hitsSinceLastHealthLog: hitsSinceLast,
    missesSinceLastHealthLog: missesSinceLast,
    cachedSegments: getCachedSegmentCount(),
    prefetchQueueDepth: segmentCachePrefetchQueue.length + segmentCachePrefetchActive,
  }, "Segment cache health");
}, 120_000).unref();

function scheduleSegmentCacheEviction() {
  if (segmentCacheEvictionTimer) return;
  const now = Date.now();
  const waitMs = Math.max(0, SEGMENT_CACHE_EVICT_DEBOUNCE_MS - (now - lastSegmentCacheEvictionMs));
  segmentCacheEvictionTimer = setTimeout(() => {
    segmentCacheEvictionTimer = null;
    lastSegmentCacheEvictionMs = Date.now();
    pruneSegmentCache();
  }, waitMs);
  segmentCacheEvictionTimer.unref();
}

function pruneSegmentCache() {
  if (segmentCacheState.sizeBytes <= SEGMENT_CACHE_MAX_BYTES) return;

  const candidates = [];
  for (const file of readdirSync(SEGMENT_CACHE_DIR)) {
    if (!file.endsWith(".meta")) continue;
    const metaPath = resolve(SEGMENT_CACHE_DIR, file);
    const dataPath = resolve(SEGMENT_CACHE_DIR, `${file.slice(0, -5)}.dat`);
    if (!existsSync(dataPath)) {
      safeUnlink(metaPath);
      continue;
    }
    try {
      const stat = statSync(dataPath);
      let cacheKey = null;
      try {
        const meta = parseSegmentCacheMeta(metaPath);
        cacheKey = meta?.cacheKey ? { logicalKey: meta.cacheKey, kind: meta.cacheKeyKind || null } : null;
      } catch {}
      candidates.push({
        dataPath,
        metaPath,
        sizeBytes: stat.size,
        atimeMs: stat.atimeMs,
        cacheKey,
      });
    } catch (err) {
      logSegmentCacheError("evict", { logicalKey: file.slice(0, -5), filenameKey: file.slice(0, -5), kind: "hash" }, err, { dataPath, metaPath });
      safeUnlink(dataPath);
      safeUnlink(metaPath);
    }
  }

  candidates.sort((a, b) => a.atimeMs - b.atimeMs);
  let evicted = 0;
  let bytesFreed = 0;
  while (segmentCacheState.sizeBytes > SEGMENT_CACHE_TARGET_BYTES && candidates.length) {
    const candidate = candidates.shift();
    if (!existsSync(candidate.dataPath) || !existsSync(candidate.metaPath)) continue;
    try {
      unlinkSync(candidate.dataPath);
      unlinkSync(candidate.metaPath);
    } catch (err) {
      logSegmentCacheError("evict", candidate.cacheKey || { logicalKey: candidate.metaPath, filenameKey: candidate.metaPath, kind: "hash" }, err, {
        dataPath: candidate.dataPath,
        metaPath: candidate.metaPath,
      });
      continue;
    }
    segmentCacheState.sizeBytes = Math.max(0, segmentCacheState.sizeBytes - candidate.sizeBytes);
    segmentCacheState.evictionCount += 1;
    evicted += 1;
    bytesFreed += candidate.sizeBytes;
  }

  if (evicted) {
    logSegmentCacheEviction({ filesEvicted: evicted, bytesFreed, newCacheSizeBytes: segmentCacheState.sizeBytes });
  }
}

function shouldCacheSegmentResponse(upstreamUrl, upstream, rangeHeader) {
  if (upstream.status !== 200 && upstream.status !== 206) return false;
  const lowerUrl = upstreamUrl.toLowerCase();
  if (/\.m3u8(\?|#|$)/i.test(lowerUrl) || /\.mpd(\?|#|$)/i.test(lowerUrl)) return false;

  const type = (upstream.headers.get("content-type") || "").toLowerCase();
  if (type.includes("mpegurl") || type.includes("x-mpegurl") || type.includes("application/dash+xml")) return false;

  const contentLength = Number.parseInt(upstream.headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength) && contentLength >= 0 && contentLength < SEGMENT_CACHE_MIN_BYTES) return false;

  if (rangeHeader && !rangeHeader.startsWith("bytes=")) return false;
  return true;
}

async function serveSegmentCacheToResponse(cacheEntry, res, onChunk, options = {}) {
  const { statusOverride = null, includeRangeHeaders = true } = options;
  const meta = cacheEntry.meta || {};
  res.status(statusOverride ?? meta.status ?? 200);
  if (meta.contentType) res.set("Content-Type", meta.contentType);
  if (meta.contentLength) res.set("Content-Length", String(meta.contentLength));
  if (includeRangeHeaders && meta.contentRange) res.set("Content-Range", meta.contentRange);
  res.set("Access-Control-Allow-Origin", "*");
  const source = createReadStream(cacheEntry.dataPath);
  if (onChunk) {
    source.on("data", (chunk) => onChunk(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)));
  }
  await pipeline(source, res);
}

function expectedRangeBytes(rangeHeader) {
  const match = String(rangeHeader || "").match(/^bytes=(\d+)-(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return end - start + 1;
}

async function readDashSegmentBody(upstream, expectedBytes) {
  if (!upstream.body) throw new Error("DASH segment response has no body");
  if (expectedBytes != null && expectedBytes > DASH_SEGMENT_MAX_BYTES) {
    throw new Error(`DASH segment exceeds ${DASH_SEGMENT_MAX_BYTES} byte safety limit`);
  }

  const declaredBytes = Number.parseInt(upstream.headers.get("content-length") || "", 10);
  if (expectedBytes != null && Number.isFinite(declaredBytes) && declaredBytes !== expectedBytes) {
    const error = new Error(`DASH segment content-length mismatch: expected ${expectedBytes}, got ${declaredBytes}`);
    error.code = "DASH_SEGMENT_INTEGRITY";
    throw error;
  }

  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      let timer = null;
      const readResult = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`DASH segment body stalled for ${DASH_SEGMENT_INACTIVITY_TIMEOUT_MS}ms`);
            error.code = "DASH_SEGMENT_TIMEOUT";
            reject(error);
          }, DASH_SEGMENT_INACTIVITY_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (readResult.done) break;
      const chunk = Buffer.from(readResult.value);
      total += chunk.length;
      if (total > DASH_SEGMENT_MAX_BYTES) {
        const error = new Error(`DASH segment exceeded ${DASH_SEGMENT_MAX_BYTES} byte safety limit`);
        error.code = "DASH_SEGMENT_INTEGRITY";
        throw error;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  }

  if (expectedBytes != null && total !== expectedBytes) {
    const error = new Error(`Incomplete DASH segment: expected ${expectedBytes} bytes, got ${total}`);
    error.code = "DASH_SEGMENT_INTEGRITY";
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function fetchDashSegmentBuffer(proxyId, rangeHeader, { label }) {
  const expectedBytes = expectedRangeBytes(rangeHeader);
  let lastError = null;

  for (let attempt = 0; attempt <= DASH_SEGMENT_FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    let proxied = null;
    try {
      proxied = await fetchProxyUpstream(proxyId, {
        rangeHeader,
        label: `${label}-attempt-${attempt + 1}`,
        signal: controller.signal,
      });
      if (!proxied) throw new Error("Proxy expired");
      if (proxied.upstream.status !== 200 && proxied.upstream.status !== 206) {
        throw new Error(`Unexpected DASH segment status ${proxied.upstream.status}`);
      }
      const buffer = await readDashSegmentBody(proxied.upstream, expectedBytes);
      return { buffer, upstream: proxied.upstream, entry: proxied.entry };
    } catch (error) {
      lastError = error;
      controller.abort(error);
      try { await proxied?.upstream?.body?.cancel?.(error); } catch {}
      if (error.code === "DASH_SEGMENT_INTEGRITY" || error.code === "DASH_SEGMENT_TIMEOUT") {
        segmentCacheState.integrityFailures += 1;
      }
      if (attempt >= DASH_SEGMENT_FETCH_RETRIES) break;
      segmentCacheState.retryCount += 1;
      log.warn({
        proxyId,
        range: rangeHeader,
        attempt: attempt + 1,
        retries: DASH_SEGMENT_FETCH_RETRIES,
        err: error.message || String(error),
      }, "Retrying incomplete DASH segment");
      if (proxied?.entry?.originalUrl) {
        try {
          await reResolveProxy(proxyId);
        } catch (refreshError) {
          log.warn({
            proxyId,
            err: refreshError.message || String(refreshError),
          }, "Failed to refresh DASH source before retry");
        }
      }
      await sleep(250 * 2 ** attempt);
    }
  }
  throw lastError || new Error("DASH segment fetch failed");
}

async function getOrFetchDashSegment(proxyId, rangeHeader, { label = "dash-segment" } = {}) {
  const entry = proxyMap.get(proxyId);
  if (!entry) throw new Error("Proxy expired");
  const cached = getSegmentCacheEntry(entry.url, rangeHeader, entry);
  if (cached) return { cacheEntry: cached, buffer: null };
  const initialPaths = getSegmentCachePaths(entry.url, rangeHeader, entry);
  const inFlight = dashSegmentFetches.get(initialPaths.filenameKey);
  if (inFlight) {
    segmentCacheState.coalescedRequests += 1;
    return inFlight;
  }

  const fetchPromise = (async () => {
    const fetched = await fetchDashSegmentBuffer(proxyId, rangeHeader, { label });
    const paths = getSegmentCachePaths(fetched.entry.url, rangeHeader, fetched.entry);
    if (fetched.buffer.length >= SEGMENT_CACHE_MIN_BYTES) {
      const startedAt = Date.now();
      writeFileSync(paths.dataPath, fetched.buffer);
      finalizeSegmentCacheWrite(paths, fetched.upstream, fetched.buffer.length, startedAt);
      const cacheEntry = getSegmentCacheEntry(fetched.entry.url, rangeHeader, fetched.entry);
      if (!cacheEntry) throw new Error("DASH segment cache publication failed");
      return { cacheEntry, buffer: null };
    }
    return {
      cacheEntry: null,
      buffer: fetched.buffer,
      contentType: fetched.upstream.headers.get("content-type") || "video/mp4",
    };
  })();

  dashSegmentFetches.set(initialPaths.filenameKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (dashSegmentFetches.get(initialPaths.filenameKey) === fetchPromise) {
      dashSegmentFetches.delete(initialPaths.filenameKey);
    }
  }
}

function serveDashSegmentBuffer(result, res, onChunk) {
  const buffer = result.buffer || Buffer.alloc(0);
  res.status(200);
  res.set("Content-Type", result.contentType || "video/mp4");
  res.set("Content-Length", String(buffer.length));
  res.set("Access-Control-Allow-Origin", "*");
  if (onChunk && buffer.length) onChunk(buffer.length);
  res.end(buffer);
}

function finalizeSegmentCacheWrite(paths, upstream, bytesWritten, startedAt) {
  const meta = {
    status: upstream.status,
    contentType: upstream.headers.get("content-type") || "application/octet-stream",
    contentLength: Number.parseInt(upstream.headers.get("content-length") || "", 10) || bytesWritten,
    contentRange: upstream.headers.get("content-range") || null,
    cacheKey: paths.logicalKey,
    cacheKeyHash: paths.filenameKey,
    cacheKeyKind: paths.kind,
    cacheKeySourceType: paths.sourceType,
  };
  writeFileSync(paths.metaPath, JSON.stringify(meta));
  segmentCacheState.sizeBytes += bytesWritten;
  scheduleSegmentCacheEviction();
  logSegmentCacheWrite({
    cacheKey: paths,
    bytesWritten,
    writeDurationMs: Date.now() - startedAt,
  });
  return { cached: true, bytes: bytesWritten };
}

async function maybeCacheSegmentResponse(upstream, upstreamUrl, rangeHeader, req, res, options = {}) {
  const { passStatus = true, passRangeHeaders = true, onChunk, metric, cacheContext = null } = options;
  const paths = getSegmentCachePaths(upstreamUrl, rangeHeader || "", cacheContext);
  const headersToCopy = ["content-type", "content-length"];
  if (passRangeHeaders) headersToCopy.push("content-range", "accept-ranges");
  for (const h of headersToCopy) {
    const value = upstream.headers.get(h);
    if (value) res.set(h, value);
  }
  res.set("Access-Control-Allow-Origin", "*");

  if (passStatus) res.status(upstream.status);

  if (!upstream.body) {
    res.end();
    return;
  }

  if (!shouldCacheSegmentResponse(upstreamUrl, upstream, rangeHeader)) {
    const source = Readable.fromWeb(upstream.body);
    if (onChunk) source.on("data", (chunk) => onChunk(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)));
    await pipeline(source, res);
    return;
  }

  const source = Readable.fromWeb(upstream.body);
  const cacheStream = createWriteStream(paths.dataPath);
  let downloaded = 0;
  let cacheError;
  let closedByClient = false;
  const startedAt = Date.now();

  const abort = () => {
    if (res.writableFinished) return;
    closedByClient = true;
    if (metric) metric.error = "Client closed connection";
    if (cacheStream.writable) cacheStream.destroy();
    source.destroy();
    upstream.body?.cancel?.().catch(() => {});
  };

  const onSourceData = (chunk) => {
    const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    downloaded += len;
    if (onChunk) onChunk(len);
    const ok = cacheStream.write(chunk);
    if (!ok) source.pause();
  };

  req?.once("aborted", abort);
  res.once("close", abort);
  source.on("data", onSourceData);
  source.once("end", () => {
    if (!cacheStream.destroyed) cacheStream.end();
  });
  cacheStream.on("drain", () => {
    if (!source.destroyed) source.resume();
  });
  cacheStream.on("error", (err) => { cacheError = err; });

  try {
    await Promise.all([
      pipeline(source, res),
      new Promise((resolve, reject) => {
        cacheStream.once("finish", resolve);
        cacheStream.once("error", reject);
      }),
    ]);
  } catch (err) {
    cacheError = cacheError || err;
    if (metric) metric.error = err.message || String(err);
    logSegmentCacheError("write", paths, err);
    if (!isAbortLikeError(err) || !(req.destroyed || res.destroyed)) throw err;
  } finally {
    req?.off("aborted", abort);
    res.off("close", abort);
    source.off("data", onSourceData);
  }

  if (cacheError || closedByClient || downloaded < SEGMENT_CACHE_MIN_BYTES) {
    purgeSegmentCacheCandidate(upstreamUrl, rangeHeader, cacheContext);
    return;
  }

  finalizeSegmentCacheWrite(paths, upstream, downloaded, startedAt);
}

function enqueueSegmentPrefetch(proxyId, range, segmentIndex = null) {
  const entry = proxyMap.get(proxyId);
  if (!entry || getSegmentCacheEntry(entry.url, range || "", entry)) return;
  const cacheKey = getSegmentCachePaths(entry?.url || "", range || "", entry);
  const key = `${cacheKey.filenameKey}|${range || ""}`;
  if (segmentCachePrefetchSet.has(key) || dashSegmentFetches.has(cacheKey.filenameKey)) return;
  segmentCachePrefetchSet.add(key);
  const item = {
    proxyId,
    range: range || "",
    key,
    segmentIndex,
    cacheKey,
    role: entry.role || null,
    generation: dashPlaybackGeneration,
  };
  if (item.role === "video") {
    const firstNonVideo = segmentCachePrefetchQueue.findIndex((queued) => queued.role !== "video");
    if (firstNonVideo === -1) segmentCachePrefetchQueue.push(item);
    else segmentCachePrefetchQueue.splice(firstNonVideo, 0, item);
  } else {
    segmentCachePrefetchQueue.push(item);
  }
  segmentCacheState.prefetchCount += 1;
  runSegmentPrefetchQueue();
}

function runSegmentPrefetchQueue() {
  while (segmentCachePrefetchActive < SEGMENT_CACHE_MAX_PREFETCHES && segmentCachePrefetchQueue.length) {
    const item = segmentCachePrefetchQueue.shift();
    if (item.generation !== dashPlaybackGeneration) {
      segmentCachePrefetchSet.delete(item.key);
      continue;
    }
    segmentCachePrefetchActive += 1;
    (async () => {
      const startedAt = Date.now();
      try {
        logSegmentPrefetchStart({ cacheKey: item.cacheKey, segmentIndex: item.segmentIndex });
        const result = await getOrFetchDashSegment(item.proxyId, item.range, { label: "segment-prefetch" });
        logSegmentPrefetchComplete({
          cacheKey: item.cacheKey,
          bytesCached: result.cacheEntry?.sizeBytes || result.buffer?.length || 0,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        log.debug({ proxyId: item.proxyId, err: err.message || String(err) }, "Segment prefetch failed");
      } finally {
        segmentCachePrefetchActive -= 1;
        segmentCachePrefetchSet.delete(item.key);
        runSegmentPrefetchQueue();
      }
    })();
  }
}

// --- Fetch with retry (exponential backoff + jitter) -----------------

async function fetchWithRetry(url, options = {}, { retries = 3, label = "fetch" } = {}) {
  let lastResp, lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason || new Error("Fetch aborted");
    try {
      const resp = await fetch(url, options);
      if (resp.ok || resp.status === 206) return resp; // success or partial content
      // Retry on transient errors
      if ((resp.status === 403 || resp.status === 429 || resp.status >= 500) && attempt < retries) {
        await resp.body?.cancel(); // consume body to free resources
        const delay = Math.min(500 * 2 ** attempt, 5000) + Math.random() * 500;
        log.warn({ label, status: resp.status, attempt: attempt + 1, retries }, "Retrying fetch");
        await new Promise((r) => setTimeout(r, delay));
        lastResp = resp;
        continue;
      }
      return resp; // non-retryable status (404, 416, etc.)
    } catch (err) {
      if (options.signal?.aborted || err.name === "AbortError") throw err;
      lastErr = err;
      if (attempt < retries) {
        const delay = Math.min(500 * 2 ** attempt, 5000) + Math.random() * 500;
        log.warn({ label, err: err.message, attempt: attempt + 1, retries }, "Retrying fetch after error");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  if (lastResp) return lastResp;
  throw lastErr;
}

// --- Stream piping helper --------------------------------------------

function isAbortLikeError(err) {
  return err?.name === "AbortError" || err?.code === "ERR_STREAM_PREMATURE_CLOSE" || err?.code === "ECONNRESET";
}

async function pipeUpstream(upstream, req, res, { passStatus = true, passRangeHeaders = true, onChunk } = {}) {
  if (passStatus) res.status(upstream.status);
  const headersToCopy = ["content-type", "content-length"];
  if (passRangeHeaders) headersToCopy.push("content-range", "accept-ranges");
  for (const h of headersToCopy) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  res.set("Access-Control-Allow-Origin", "*");

  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(upstream.body);
  if (onChunk) {
    nodeStream.on("data", (chunk) => {
      onChunk(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
    });
  }

  const abortUpstream = () => {
    if (res.writableFinished) return;
    nodeStream.destroy();
    const cancelPromise = upstream.body?.cancel?.();
    if (cancelPromise && typeof cancelPromise.catch === "function") cancelPromise.catch(() => {});
  };

  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);
  try {
    await pipeline(nodeStream, res);
  } catch (err) {
    if (!isAbortLikeError(err) && !req.destroyed && !res.destroyed) throw err;
  } finally {
    req.off("aborted", abortUpstream);
    res.off("close", abortUpstream);
  }
}

function buildProxyRequestHeaders(entry, rangeHeader) {
  const headers = proxyHeaders(entry);
  if (rangeHeader) {
    headers.Range = rangeHeader;
    // Byte offsets are defined against the original representation. Undici's
    // automatic compression negotiation can make large Bilibili range bodies
    // terminate early, and compression also makes Content-Length ambiguous.
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "accept-encoding") delete headers[name];
    }
    headers["Accept-Encoding"] = "identity";
  }
  return headers;
}

async function fetchProxyUpstream(proxyId, { rangeHeader, label = "proxy", signal, req = null, metric = null } = {}) {
  let entry = proxyMap.get(proxyId);
  if (!entry) return null;
  touchProxyEntry(entry);
  setProxyMetricRequest(metric, req || { headers: {} }, entry, proxyId, rangeHeader);

  const expiry = getProxyExpiryState(entry);
  if (entry.originalUrl && expiry.needsRefresh) {
    log.info(proxyLogMeta(proxyId, entry, { range: rangeHeader, reason: expiry.isExpired ? "expired" : "expiring_soon" }), "Refreshing proxy URL before upstream request");
    await reResolveProxy(proxyId);
    entry = proxyMap.get(proxyId) || entry;
    setProxyMetricRequest(metric, req || { headers: {} }, entry, proxyId, rangeHeader);
  }

  let upstream;
  let upstreamStartedAt = Date.now();
  try {
    upstream = await fetchWithRetry(
      entry.url,
      { headers: buildProxyRequestHeaders(entry, rangeHeader), redirect: "follow", signal },
      { label },
    );
  } catch (err) {
    if (!(isAbortLikeError(err) && signal?.aborted)) {
      logProxyUrlHealth({ level: "error", proxyId, entry, err, event: "fetch_failed" });
    }
    if (metric) metric.error = err.message || String(err);
    throw err;
  }
  setProxyMetricUpstream(metric, upstream, Date.now() - upstreamStartedAt);

  if (upstream.status === 403 && entry.originalUrl) {
    const currentExpiry = getProxyExpiryState(entry);
    warnOnProxyStatus(proxyId, entry, upstream, "upstream_rejected");
    log.warn(proxyLogMeta(proxyId, entry, { range: rangeHeader, status: upstream.status, urlMayBeExpired: currentExpiry.isExpired || currentExpiry.needsRefresh }), "Upstream rejected proxy request");
    await upstream.body?.cancel();
    if (await reResolveProxy(proxyId)) {
      entry = proxyMap.get(proxyId) || entry;
      setProxyMetricRequest(metric, req || { headers: {} }, entry, proxyId, rangeHeader);
      upstreamStartedAt = Date.now();
      try {
        upstream = await fetchWithRetry(
          entry.url,
          { headers: buildProxyRequestHeaders(entry, rangeHeader), redirect: "follow", signal },
          { label: `${label}-reresolved` },
        );
      } catch (err) {
        if (!(isAbortLikeError(err) && signal?.aborted)) {
          logProxyUrlHealth({ level: "error", proxyId, entry, err, event: "fetch_failed_after_refresh" });
        }
        if (metric) metric.error = err.message || String(err);
        throw err;
      }
      setProxyMetricUpstream(metric, upstream, Date.now() - upstreamStartedAt);
    }
  }

  touchProxyEntry(entry);
  warnOnProxyStatus(proxyId, entry, upstream, "upstream_status");
  if (upstream.status !== 200 && upstream.status !== 206) {
    log.warn(proxyLogMeta(proxyId, entry, {
      range: rangeHeader,
      status: upstream.status,
      contentRange: upstream.headers.get("content-range"),
      retryAfterRefresh: upstream.status === 403 && !!entry.originalUrl,
    }), "Unexpected upstream proxy response");
  }
  return { entry, upstream };
}

// Raw stream proxy (mp4, ts segments, etc.)
app.get("/api/proxy", async (req, res) => {
  if (!proxyMap.has(req.query.id)) return res.status(404).json({ error: "Unknown stream" });
  const metric = beginProxyMetric("/api/proxy");
  trackProxyMetricLifecycle(res, metric);
  const entry = proxyMap.get(req.query.id);
  const rangeHeader = req.headers.range || "";

  try {
    const cacheEntry = entry ? getSegmentCacheEntry(entry.url, rangeHeader, entry) : null;
    if (cacheEntry) {
      segmentCacheState.hits += 1;
      if (cacheEntry.kind === "hash") segmentCacheState.hashKeyHits += 1;
      else segmentCacheState.logicalKeyHits += 1;
      logSegmentCacheHit({ cacheKey: cacheEntry, cacheEntry, proxyId: req.query.id, rangeHeader });
      await serveSegmentCacheToResponse(cacheEntry, res, (bytes) => recordProxyMetricBytes(metric, bytes));
      return;
    }

    segmentCacheState.misses += 1;
    logSegmentCacheMiss({
      cacheKey: getSegmentCachePaths(entry?.url || "", rangeHeader, entry),
      proxyId: req.query.id,
      upstreamUrl: entry?.url || "",
      rangeHeader,
    });
    const proxied = await fetchProxyUpstream(req.query.id, {
      rangeHeader: rangeHeader || null,
      label: "proxy",
      req,
      metric,
    });
    if (!proxied) return res.status(404).json({ error: "Unknown stream" });
    await maybeCacheSegmentResponse(proxied.upstream, proxied.entry.url, rangeHeader, req, res, {
      onChunk: (bytes) => recordProxyMetricBytes(metric, bytes),
      metric,
      cacheContext: proxied.entry,
    });
  } catch (e) {
    if (metric) metric.error = e.message || String(e);
    if (!res.headersSent && !(isAbortLikeError(e) && (req.destroyed || res.destroyed))) {
      res.status(502).json({ error: e.message });
    }
  }
});

// DASH segment proxy — serve a specific byte range from upstream
app.get("/api/proxy/range", async (req, res) => {
  if (!proxyMap.has(req.query.id)) return res.status(404).json({ error: "Unknown stream" });
  const range = req.query.r;
  if (!range) return res.status(400).json({ error: "range required" });
  const metric = beginProxyMetric("/api/proxy/range");
  trackProxyMetricLifecycle(res, metric);

  try {
    const proxied = await fetchProxyUpstream(req.query.id, {
      rangeHeader: `bytes=${range}`,
      label: "proxy/range",
      req,
      metric,
    });
    if (!proxied) return res.status(404).json({ error: "Unknown stream" });
    res.status(200); // Always 200 for DASH segment fetches
    await pipeUpstream(proxied.upstream, req, res, {
      passStatus: false,
      passRangeHeaders: false,
      onChunk: (bytes) => recordProxyMetricBytes(metric, bytes),
    });
  } catch (e) {
    if (metric) metric.error = e.message || String(e);
    if (!res.headersSent && !(isAbortLikeError(e) && (req.destroyed || res.destroyed))) {
      res.status(502).json({ error: e.message });
    }
  }
});

// Max bitrate for HLS variant filtering (matches FORMAT_SELECTOR cap)
const HLS_MAX_BANDWIDTH = 4800_000;

function proxyHlsResourceUrl(resourceUrl, baseUrl, headers = null) {
  const absoluteUrl = /^https?:\/\//i.test(resourceUrl)
    ? resourceUrl
    : new URL(resourceUrl, baseUrl).href;
  const id = proxyRegister(absoluteUrl, headers);
  return /\.m3u8(?:[?#]|$)/i.test(absoluteUrl)
    ? `/api/proxy/hls?id=${id}`
    : `/api/proxy?id=${id}`;
}

// HLS proxy — fetch m3u8 and rewrite all URLs to go through our proxy
app.get("/api/proxy/hls", async (req, res) => {
  const entry = proxyMap.get(req.query.id);
  if (!entry) return res.status(404).json({ error: "Unknown stream" });
  const metric = beginProxyMetric("/api/proxy/hls");
  setProxyMetricRequest(metric, req, entry, req.query.id);
  trackProxyMetricLifecycle(res, metric);

  try {
    const upstreamStartedAt = Date.now();
    let upstream;
    try {
      upstream = await fetch(entry.url, { headers: proxyHeaders(entry), redirect: "follow" });
    } catch (err) {
      metric.error = err.message || String(err);
      logProxyUrlHealth({ level: "error", proxyId: req.query.id, entry, err, event: "fetch_failed" });
      throw err;
    }
    setProxyMetricUpstream(metric, upstream, Date.now() - upstreamStartedAt);
    warnOnProxyStatus(req.query.id, entry, upstream, "upstream_status");
    let body = await upstream.text();
    const baseUrl = new URL(entry.url);

    // Filter master playlist — drop variants above bitrate cap
    const isMaster = body.includes("#EXT-X-STREAM-INF");
    if (isMaster) {
      const lines = body.split("\n");
      const filtered = [];
      let skip = false;
      for (const line of lines) {
        if (line.startsWith("#EXT-X-STREAM-INF")) {
          const bwMatch = line.match(/BANDWIDTH=(\d+)/);
          skip = bwMatch && Number(bwMatch[1]) > HLS_MAX_BANDWIDTH;
        }
        if (skip && !line.startsWith("#")) {
          skip = false; // skip the URL line following the dropped #EXT-X-STREAM-INF
          continue;
        }
        if (!skip) filtered.push(line);
        else skip = line.startsWith("#"); // keep skipping consecutive tags for same variant
      }
      body = filtered.join("\n");
    }

    // URI attributes live inside tags such as EXT-X-MAP, EXT-X-KEY, and
    // EXT-X-MEDIA. Leaving them untouched makes the browser resolve them
    // relative to /api/proxy/hls instead of the upstream playlist.
    body = body.replace(/URI="([^"]+)"/g, (match, resourceUrl) => {
      return `URI="${proxyHlsResourceUrl(resourceUrl, baseUrl, entry.headers)}"`;
    });

    // Rewrite each non-comment, non-empty line.
    body = body.replace(/^(?!#)(\S+.*)$/gm, (match, line) => {
      const trimmed = line.trim();
      if (!trimmed) return match;
      return proxyHlsResourceUrl(trimmed, baseUrl, entry.headers);
    });

    recordProxyMetricBytes(metric, Buffer.byteLength(body));
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(body);
  } catch (e) {
    if (metric) metric.error = e.message || String(e);
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// --- Plex integration ------------------------------------------------

async function plexApi(path) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${PLEX_URL}${path}${sep}X-Plex-Token=${PLEX_TOKEN}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Plex API ${res.status}: ${res.statusText}`);
  return res.json();
}

function plexTranscodeParams(ratingKey, { subtitleStreamID, audioStreamID, offsetSec, session } = {}) {
  return new URLSearchParams({
    hasMDE: "1",
    path: `/library/metadata/${ratingKey}`,
    mediaIndex: "0",
    partIndex: "0",
    protocol: "hls",
    fastSeek: "1",
    directPlay: "0",
    directStream: "1",
    directStreamAudio: "1",
    videoResolution: "1920x1080",
    maxVideoBitrate: "8000",
    subtitleSize: "100",
    subtitles: subtitleStreamID ? "burn" : "none",
    audioBoost: "280",
    location: "lan",
    addDebugOverlay: "0",
    autoAdjustQuality: "0",
    autoAdjustSubtitle: "0",
    mediaBufferSize: "102400",
    ...(audioStreamID ? { audioStreamID } : {}),
    ...(offsetSec ? { offset: String(offsetSec) } : {}),
    session,
    "X-Plex-Incomplete-Segments": "1",
    "X-Plex-Client-Identifier": "drive-in-player",
    "X-Plex-Product": "Drive-In",
    "X-Plex-Features": "external-media,indirect-media,hub-style-list",
    "X-Plex-Platform": "Chrome",
    "X-Plex-Platform-Version": "136.0",
    "X-Plex-Device": "Linux",
    "X-Plex-Device-Name": "Drive-In Player",
    "X-Plex-Model": "bundled",
    "X-Plex-Token": PLEX_TOKEN,
  });
}

async function plexTranscodeUrl(ratingKey, opts = {}) {
  const session = opts.session || `di-${Date.now()}`;
  const params = plexTranscodeParams(ratingKey, { ...opts, session });
  // Call decision endpoint first — Plex needs this to set up the transcode pipeline
  const decisionUrl = `${PLEX_URL}/video/:/transcode/universal/decision?${params}`;
  const decisionRes = await fetch(decisionUrl, { headers: { Accept: "application/json" } });
  const decisionBody = await decisionRes.json().catch(() => null);
  const mc = decisionBody?.MediaContainer;
  const decisionStream = mc?.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream;
  const subStreams = decisionStream?.filter((s) => s.streamType === 3) || [];
  log.info({
    status: decisionRes.status,
    session,
    generalDecisionCode: mc?.generalDecisionCode,
    generalDecisionText: mc?.generalDecisionText,
    transcodeDecisionCode: mc?.transcodeDecisionCode,
    transcodeDecisionText: mc?.transcodeDecisionText,
    subtitleDecision: subStreams.map((s) => ({ id: s.id, codec: s.codec, decision: s.decision, burn: s.burn })),
  }, "[plex] transcode decision");
  // Fetch the master playlist eagerly so Plex starts transcoding before the
  // browser asks for its first media segment.
  const startHlsUrl = `${PLEX_URL}/video/:/transcode/universal/start.m3u8?${params}`;
  plexHlsManifestUrl = startHlsUrl;
  plexHlsManifestCache = null;

  try {
    log.info({ session }, "[plex] Fetching start.m3u8 (this triggers transcode)...");
    const manifestRes = await fetch(startHlsUrl);
    if (manifestRes.ok) {
      let body = await manifestRes.text();
      body = body.replace(/\/video\/:\/transcode\/universal\//g, "/api/plex/hls/");
      plexHlsManifestCache = body;
      log.info({ session, bodyLength: body.length }, "[plex] start.m3u8 cached, transcode ready");
    } else {
      log.warn({ session, status: manifestRes.status }, "[plex] start.m3u8 failed");
    }
  } catch (e) {
    log.error({ session, err: e.message }, "[plex] start.m3u8 fetch error");
  }

  return `/api/plex/hls/master.m3u8`;
}

// --- Plex HLS proxy ---------------------------------------------------
let plexHlsManifestUrl = null;
let plexHlsManifestCache = null;
const plexProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  followRedirects: true,
  ws: true,
});
plexProxy.on("error", (err, _req, res) => {
  log.error({ err: err.message }, "[plex-proxy] error");
  if (_req?.driveInProxyMetric) _req.driveInProxyMetric.error = err.message || String(err);
  if (res.writeHead) res.writeHead(502).end();
});
plexProxy.on("proxyRes", (proxyRes, req) => {
  const metric = req.driveInProxyMetric;
  if (!metric) return;
  metric.upstreamStatus = proxyRes.statusCode;
  const contentLength = proxyRes.headers?.["content-length"];
  metric.upstreamContentLength = contentLength ? Number(contentLength) : null;
  metric.upstreamResponseTimeMs = Date.now() - metric.startedAt;
  proxyRes.on("data", (chunk) => {
    recordProxyMetricBytes(metric, Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
  });
});

function rewritePlexHlsManifest(body) {
  return body.replace(/\/video\/:\/transcode\/universal\//g, "/api/plex/hls/");
}

app.get("/api/plex/hls/master.m3u8", async (_req, res) => {
  if (!plexHlsManifestUrl) return res.status(404).json({ error: "No active Plex transcode" });
  if (plexHlsManifestCache) {
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-cache");
    res.set("Access-Control-Allow-Origin", "*");
    return res.send(plexHlsManifestCache);
  }

  try {
    const upstream = await fetch(plexHlsManifestUrl);
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Plex HLS ${upstream.status}` });
    plexHlsManifestCache = rewritePlexHlsManifest(await upstream.text());
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-cache");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(plexHlsManifestCache);
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: error.message });
  }
});

app.use("/api/plex/hls/*path", async (req, res) => {
  const fullPath = req.originalUrl || (req.baseUrl + req.url) || req.url;
  const plexPath = fullPath.replace("/api/plex/hls/", "/video/:/transcode/universal/");
  const tokenizedPath = `${plexPath}${plexPath.includes("?") ? "&" : "?"}X-Plex-Token=${PLEX_TOKEN}`;

  if (/\.m3u8(?:\?|$)/i.test(plexPath)) {
    const metric = beginProxyMetric("/api/plex/hls/*manifest");
    metric.url = truncateUrl(`${PLEX_URL}${plexPath}`, 300);
    trackProxyMetricLifecycle(res, metric);
    try {
      const startedAt = Date.now();
      const upstream = await fetch(`${PLEX_URL}${tokenizedPath}`);
      setProxyMetricUpstream(metric, upstream, Date.now() - startedAt);
      if (!upstream.ok) return res.status(upstream.status).json({ error: `Plex HLS ${upstream.status}` });
      const body = rewritePlexHlsManifest(await upstream.text());
      recordProxyMetricBytes(metric, Buffer.byteLength(body));
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-cache");
      res.set("Access-Control-Allow-Origin", "*");
      return res.send(body);
    } catch (error) {
      metric.error = error.message || String(error);
      if (!res.headersSent) return res.status(502).json({ error: error.message });
      return;
    }
  }

  const metric = beginProxyMetric("/api/plex/hls/*segment");
  metric.range = req.headers.range || null;
  metric.url = truncateUrl(`${PLEX_URL}${plexPath}`, 300);
  req.driveInProxyMetric = metric;
  trackProxyMetricLifecycle(res, metric);
  req.url = tokenizedPath;
  plexProxy.web(req, res, { target: PLEX_URL });
});
// Plex API routes
app.get("/api/plex/libraries", async (_req, res) => {
  if (!PLEX_TOKEN) return res.status(503).json({ error: "Plex token not configured" });
  try {
    const data = await plexApi("/library/sections");
    const libs = data.MediaContainer.Directory.map((d) => ({
      id: d.key, title: d.title, type: d.type,
    }));
    res.json(libs);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/plex/library/:id", async (req, res) => {
  if (!PLEX_TOKEN) return res.status(503).json({ error: "Plex token not configured" });
  const { id } = req.params;
  const sort = req.query.sort || "addedAt:desc";
  const start = req.query.start || 0;
  const size = req.query.size;
  const sizeParam = size && size !== "0" ? `&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}` : "";
  try {
    const data = await plexApi(`/library/sections/${id}/all?sort=${sort}${sizeParam}`);
    const items = (data.MediaContainer.Metadata || []).map((m) => {
      const media = m.Media?.[0];
      return {
        ratingKey: m.ratingKey, title: m.title, year: m.year,
        type: m.type, thumb: m.thumb,
        duration: m.duration ? Math.round(m.duration / 60000) : null,
        videoCodec: media?.videoCodec, audioCodec: media?.audioCodec,
        resolution: media ? `${media.width}x${media.height}` : null,
        viewCount: m.viewCount || 0,
        viewOffset: m.viewOffset || 0,
        // For TV shows
        childCount: m.childCount, leafCount: m.leafCount,
        viewedLeafCount: m.viewedLeafCount || 0,
      };
    });
    res.json({ total: data.MediaContainer.totalSize, items });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/plex/show/:id/episodes", async (req, res) => {
  if (!PLEX_TOKEN) return res.status(503).json({ error: "Plex token not configured" });
  try {
    const data = await plexApi(`/library/metadata/${req.params.id}/allLeaves`);
    const eps = (data.MediaContainer.Metadata || []).map((m) => {
      const media = m.Media?.[0];
      return {
        ratingKey: m.ratingKey, title: m.title,
        season: m.parentIndex, episode: m.index,
        duration: m.duration ? Math.round(m.duration / 60000) : null,
        thumb: m.thumb || null,
        videoCodec: media?.videoCodec,
        viewCount: m.viewCount || 0,
        viewOffset: m.viewOffset || 0,
      };
    });
    res.json(eps);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/plex/search", async (req, res) => {
  if (!PLEX_TOKEN) return res.status(503).json({ error: "Plex token not configured" });
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "q required" });
  try {
    const data = await plexApi(`/hubs/search?query=${encodeURIComponent(q)}&limit=10`);
    const results = [];
    for (const hub of data.MediaContainer.Hub || []) {
      for (const m of hub.Metadata || []) {
        results.push({
          ratingKey: m.ratingKey, title: m.title, year: m.year,
          type: m.type, thumb: m.thumb,
        });
      }
    }
    res.json(results);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/plex/subtitles/:id", async (req, res) => {
  if (!PLEX_TOKEN) return res.status(503).json({ error: "Plex token not configured" });
  try {
    const data = await plexApi(`/library/metadata/${req.params.id}`);
    const part = data.MediaContainer.Metadata[0].Media[0].Part[0];
    const subs = (part.Stream || [])
      .filter((s) => s.streamType === 3)
      .map((s) => ({
        id: s.id, codec: s.codec, language: s.language,
        title: s.title || s.displayTitle, displayTitle: s.displayTitle,
      }));
    res.json(subs);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/plex/audio/:id", async (req, res) => {
  if (!PLEX_TOKEN) return res.status(503).json({ error: "Plex token not configured" });
  try {
    const data = await plexApi(`/library/metadata/${req.params.id}`);
    const part = data.MediaContainer.Metadata[0].Media[0].Part[0];
    const tracks = (part.Stream || [])
      .filter((s) => s.streamType === 2)
      .map((s) => ({
        id: s.id, codec: s.codec, language: s.language, channels: s.channels,
        title: s.title || s.displayTitle, displayTitle: s.displayTitle,
        selected: !!s.selected,
      }));
    res.json(tracks);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

async function playPlexNow({ ratingKey, subtitleStreamID, audioStreamID, offset } = {}) {
  if (!ratingKey) {
    const err = new Error("ratingKey required");
    err.status = 400;
    throw err;
  }
  if (!PLEX_TOKEN) {
    const err = new Error("Plex token not configured");
    err.status = 503;
    throw err;
  }
  if (!playerWs || playerWs.readyState !== 1) {
    const err = new Error("No player connected");
    err.status = 503;
    throw err;
  }

  updateState({ status: "resolving", url: `plex://${ratingKey}` });

  const data = await plexApi(`/library/metadata/${ratingKey}`);
  const meta = data.MediaContainer.Metadata[0];
  const media = meta.Media[0];
  const part = media.Part[0];
  const title = meta.grandparentTitle
    ? `${meta.grandparentTitle} S${meta.parentIndex}E${meta.index} — ${meta.title}`
    : meta.title;

  // Set subtitle and audio selection on the Plex part before transcoding
  const partParams = new URLSearchParams({ "X-Plex-Token": PLEX_TOKEN, allParts: "1" });
  if (subtitleStreamID) {
    partParams.set("subtitleStreamID", subtitleStreamID);
  } else {
    partParams.set("subtitleStreamID", "0");
  }
  if (audioStreamID) {
    partParams.set("audioStreamID", audioStreamID);
  }
  const putRes = await fetch(`${PLEX_URL}/library/parts/${part.id}?${partParams}`, { method: "PUT" });
  log.info({ status: putRes.status, partId: part.id, subtitleStreamID: subtitleStreamID || 0 }, "[plex] PUT subtitle/audio on part");

  resetDashSegmentSession();
  await killPipeline();

  // Resume position: offset (from client, in ms) or viewOffset (from Plex, in ms)
  const resumeMs = offset || meta.viewOffset || 0;
  const resumeSec = resumeMs ? Math.floor(resumeMs / 1000) : 0;
  const playerUrl = await plexTranscodeUrl(ratingKey, { subtitleStreamID, audioStreamID, offsetSec: resumeSec });

  updateState({ status: "playing", title, resolvedUrl: `plex://${ratingKey}`, isLive: false });

  // Collect subtitle and audio tracks for player UI
  const subtitles = (part.Stream || [])
    .filter((s) => s.streamType === 3)
    .map((s) => ({ id: s.id, codec: s.codec, language: s.language, title: s.title || s.displayTitle, displayTitle: s.displayTitle }));
  const audioTracks = (part.Stream || [])
    .filter((s) => s.streamType === 2)
    .map((s) => ({ id: s.id, codec: s.codec, language: s.language, channels: s.channels, title: s.title || s.displayTitle, displayTitle: s.displayTitle, selected: !!s.selected }));

  broadcast({
    type: "play",
    url: playerUrl,
    mediaSource: { type: "hls", url: playerUrl },
    title,
    isLive: false,
    duration: meta.duration ? Math.round(meta.duration / 1000) : null,
    thumbnail: meta.thumb ? `${PLEX_URL}${meta.thumb}?X-Plex-Token=${PLEX_TOKEN}` : null,
    plex: {
      ratingKey, subtitles, audioTracks,
      activeSubtitleID: subtitleStreamID || null,
      activeAudioID: audioStreamID || null,
    },
    startTime: resumeMs ? resumeMs / 1000 : 0,
  });

  addToHistory({
    title,
    plex: { ratingKey },
    thumbnail: meta.art
      ? `/api/plex/thumb?path=${encodeURIComponent(meta.art)}`
      : meta.thumb ? `/api/plex/thumb?path=${encodeURIComponent(meta.thumb)}` : null,
    duration: meta.duration ? Math.round(meta.duration / 1000) : null,
  });

  return { ok: true, title };
}

app.post("/api/plex/play", async (req, res) => {
  try {
    res.json(await playPlexNow(req.body));
  } catch (e) {
    updateState({ status: "idle" });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Report playback progress to Plex (called periodically by player)
app.post("/api/plex/progress", async (req, res) => {
  const { ratingKey, timeMs } = req.body;
  if (!ratingKey || !PLEX_TOKEN) return res.json({ ok: true });
  try {
    const params = new URLSearchParams({
      key: ratingKey,
      identifier: "com.plexapp.plugins.library",
      time: String(Math.floor(timeMs)),
      state: "playing",
      "X-Plex-Token": PLEX_TOKEN,
      "X-Plex-Client-Identifier": "drive-in-player",
    });
    await fetch(`${PLEX_URL}/:/progress?${params}`);
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// Proxy Plex thumbnails — cached to disk (so browser doesn't need token)
app.get("/api/plex/thumb", async (req, res) => {
  const path = req.query.path;
  if (!path || !PLEX_TOKEN) return res.status(400).end();

  // Stable cache key from path
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  const cacheBase = resolve(THUMB_CACHE_DIR, `plex_${Math.abs(h).toString(36)}`);
  const metaFile = cacheBase + ".meta";
  const dataFile = cacheBase + ".dat";

  // Serve from cache (data + MIME stored separately)
  if (existsSync(dataFile) && existsSync(metaFile)) {
    try {
      const mime = readFileSync(metaFile, "utf8").trim();
      res.set("Content-Type", mime);
      res.set("Cache-Control", "public, max-age=604800");
      return res.sendFile(dataFile, { dotfiles: "allow" });
    } catch {}
  }

  try {
    const upstream = await fetch(`${PLEX_URL}${path}?X-Plex-Token=${PLEX_TOKEN}`);
    if (!upstream.ok) return res.status(upstream.status).end();
    const mime = upstream.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await upstream.arrayBuffer());
    writeFileSync(dataFile, buf);
    writeFileSync(metaFile, mime);
    res.set("Content-Type", mime);
    res.set("Cache-Control", "public, max-age=604800");
    res.send(buf);
  } catch { res.status(502).end(); }
});

// Proxy external thumbnails — cached to disk
app.get("/api/thumb", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).end();

  // Stable filename from URL
  let h = 0;
  for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  const ext = url.match(/\.(jpe?g|png|webp|avif)/i)?.[1] || "jpg";
  const cacheFile = resolve(THUMB_CACHE_DIR, `${Math.abs(h).toString(36)}.${ext}`);

  // Serve from cache
  if (existsSync(cacheFile)) {
    res.set("Content-Type", ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800");
    return res.sendFile(cacheFile, { dotfiles: "allow" });
  }

  try {
    const upstream = await fetch(url, { redirect: "follow" });
    if (!upstream.ok) return res.status(upstream.status).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    writeFileSync(cacheFile, buf);
    res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800");
    res.send(buf);
  } catch { res.status(502).end(); }
});

// --- History API -----------------------------------------------------

app.delete("/api/history", (req, res) => {
  const { url, ratingKey } = req.body || {};
  if (!url && !ratingKey) return res.status(400).json({ error: "url or ratingKey required" });
  const history = loadHistory();
  const filtered = history.filter((h) => {
    if (ratingKey) return h.plex?.ratingKey !== String(ratingKey);
    return h.url !== url;
  });
  saveHistory(filtered);
  res.json({ ok: true, remaining: filtered.length });
});

app.get("/api/history", async (_req, res) => {
  const history = loadHistory();

  // Fix non-proxied external thumbnail URLs in history
  const fixed = history.map((h) => {
    if (h.thumbnail && h.thumbnail.startsWith("http")) {
      return { ...h, thumbnail: `/api/thumb?url=${encodeURIComponent(h.thumbnail)}` };
    }
    return h;
  });

  if (!PLEX_TOKEN) return res.json(fixed);

  // Enrich Plex items with current viewOffset from Plex
  const plexKeys = fixed.filter((h) => h.plex?.ratingKey).map((h) => h.plex.ratingKey);
  if (!plexKeys.length) return res.json(fixed);

  try {
    const data = await plexApi(`/library/metadata/${plexKeys.join(",")}`);
    const metaMap = {};
    for (const m of data.MediaContainer?.Metadata || []) {
      const thumb = m.art
        ? `/api/plex/thumb?path=${encodeURIComponent(m.art)}`
        : m.thumb ? `/api/plex/thumb?path=${encodeURIComponent(m.thumb)}` : null;
      metaMap[m.ratingKey] = { viewOffset: m.viewOffset || 0, viewCount: m.viewCount || 0, thumbnail: thumb };
    }
    const enriched = fixed.map((h) => {
      if (h.plex?.ratingKey && metaMap[h.plex.ratingKey]) {
        const fresh = metaMap[h.plex.ratingKey];
        return { ...h, viewOffset: fresh.viewOffset, viewCount: fresh.viewCount, thumbnail: fresh.thumbnail || h.thumbnail };
      }
      return h;
    });
    res.json(enriched);
  } catch {
    res.json(fixed);
  }
});

// --- Playlist API ----------------------------------------------------

async function buildPlaylistItemInput(body = {}) {
  return buildQueueItemInput(body);
}

async function playlistItemsFromUrl(url) {
  const info = await ytdlpFlatPlaylist(url);
  const entries = Array.isArray(info.entries) ? info.entries : [];
  const items = entries.map((entry) => {
    const entryUrl = playlistEntryUrl(entry);
    if (!entryUrl) return null;
    const thumb = Array.isArray(entry.thumbnails) && entry.thumbnails.length
      ? entry.thumbnails[entry.thumbnails.length - 1]?.url
      : entry.thumbnail || null;
    return {
      url: entryUrl,
      title: entry.title || entry.fulltitle || entryUrl,
      thumbnail: thumb,
      duration: Number.isFinite(Number(entry.duration)) ? Math.floor(Number(entry.duration)) : null,
      metadata: {
        importedFrom: url,
        extractor: entry.extractor_key || entry.ie_key || info.extractor_key || null,
        playlistTitle: info.title || null,
      },
    };
  }).filter(Boolean);
  return {
    title: info.title || info.playlist_title || "Imported Playlist",
    items,
  };
}

app.get("/api/playlists", (_req, res) => {
  res.json(listPlaylists());
});

app.post("/api/playlists", (req, res) => {
  try {
    const playlist = createPlaylist(req.body || {});
    broadcastPlaylists();
    res.status(201).json({ ok: true, playlist });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/playlists/import-url", async (req, res) => {
  const { url, name, enqueue } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const imported = await playlistItemsFromUrl(url);
    if (!imported.items.length) return res.status(400).json({ error: "No playlist entries found" });
    const playlist = createPlaylist({ name: name || imported.title, description: `Imported from ${url}` });
    for (const item of imported.items) addPlaylistItem(playlist.id, item);
    const hydrated = getPlaylist(playlist.id);
    broadcastPlaylists();
    if (enqueue) {
      enqueuePlaylist(playlist.id);
      broadcastQueue();
    }
    res.status(201).json({ ok: true, playlist: hydrated, imported: imported.items.length, queue: listQueue() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/playlists/:id", (req, res) => {
  const playlist = getPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: "playlist not found" });
  res.json(playlist);
});

app.patch("/api/playlists/:id", (req, res) => {
  try {
    const playlist = updatePlaylist(req.params.id, req.body || {});
    if (!playlist) return res.status(404).json({ error: "playlist not found" });
    broadcastPlaylists();
    res.json({ ok: true, playlist });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/playlists/:id", (req, res) => {
  const playlist = deletePlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: "playlist not found" });
  broadcastPlaylists();
  res.json({ ok: true, playlist });
});

app.post("/api/playlists/:id/items", async (req, res) => {
  if (!getPlaylist(req.params.id)) return res.status(404).json({ error: "playlist not found" });
  try {
    const item = addPlaylistItem(req.params.id, await buildPlaylistItemInput(req.body || {}));
    broadcastPlaylists();
    res.status(201).json({ ok: true, item, playlist: getPlaylist(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/playlists/:id/items/:itemId", (req, res) => {
  const item = removePlaylistItem(req.params.id, req.params.itemId);
  if (!item) return res.status(404).json({ error: "playlist item not found" });
  broadcastPlaylists();
  res.json({ ok: true, item, playlist: getPlaylist(req.params.id) });
});

app.post("/api/playlists/:id/reorder", (req, res) => {
  if (!getPlaylist(req.params.id)) return res.status(404).json({ error: "playlist not found" });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: "ids array required" });
  const playlist = reorderPlaylistItems(req.params.id, ids);
  broadcastPlaylists();
  res.json({ ok: true, playlist });
});

app.post("/api/playlists/:id/enqueue", (req, res) => {
  if (!getPlaylist(req.params.id)) return res.status(404).json({ error: "playlist not found" });
  const added = enqueuePlaylist(req.params.id, { playNext: !!req.body?.playNext });
  broadcastQueue();
  res.json({ ok: true, added, queue: listQueue() });
});

// --- Queue API -------------------------------------------------------

async function buildQueueItemInput(body = {}) {
  const ratingKey = body.ratingKey ? String(body.ratingKey) : null;
  if (!ratingKey || body.title || !PLEX_TOKEN) return body;

  try {
    const data = await plexApi(`/library/metadata/${ratingKey}`);
    const meta = data.MediaContainer.Metadata[0];
    const title = meta.grandparentTitle
      ? `${meta.grandparentTitle} S${meta.parentIndex}E${meta.index} — ${meta.title}`
      : meta.title;
    return {
      ...body,
      title,
      thumbnail: meta.art
        ? `/api/plex/thumb?path=${encodeURIComponent(meta.art)}`
        : meta.thumb ? `/api/plex/thumb?path=${encodeURIComponent(meta.thumb)}` : null,
      duration: meta.duration ? Math.round(meta.duration / 1000) : null,
    };
  } catch (err) {
    log.warn({ err: err?.message, ratingKey }, "Failed to enrich queued Plex item");
    return body;
  }
}

async function playQueueItem(item) {
  if (item.sourceType === "plex") {
    return playPlexNow({ ratingKey: item.ratingKey });
  }
  return playUrlNow({ url: item.url });
}

async function playNextFromQueue(id = null) {
  const item = shiftQueueItem(id);
  if (!item) return null;
  broadcastQueue();
  try {
    const result = await playQueueItem(item);
    return { ok: true, item, result, queue: listQueue() };
  } catch (err) {
    addQueueItem(item, { playNext: true });
    broadcastQueue();
    throw err;
  }
}

app.get("/api/queue", (_req, res) => {
  res.json(listQueue());
});

app.post("/api/queue", async (req, res) => {
  try {
    const item = addQueueItem(await buildQueueItemInput(req.body), { playNext: !!req.body?.playNext });
    broadcastQueue();
    res.status(201).json({ ok: true, item, queue: listQueue() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/queue/reorder", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: "ids array required" });
  const queue = reorderQueue(ids);
  broadcastQueue();
  res.json({ ok: true, queue });
});

app.post("/api/queue/next", async (_req, res) => {
  try {
    const result = await playNextFromQueue();
    if (!result) return res.status(404).json({ error: "queue empty" });
    res.json(result);
  } catch (err) {
    updateState({ status: "idle" });
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/queue/:id/play", async (req, res) => {
  if (!getQueueItem(req.params.id)) return res.status(404).json({ error: "queue item not found" });
  try {
    res.json(await playNextFromQueue(req.params.id));
  } catch (err) {
    updateState({ status: "idle" });
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/queue/:id", (req, res) => {
  const item = removeQueueItem(req.params.id);
  if (!item) return res.status(404).json({ error: "queue item not found" });
  broadcastQueue();
  res.json({ ok: true, item, queue: listQueue() });
});

app.delete("/api/queue", (_req, res) => {
  const cleared = clearQueue();
  broadcastQueue();
  res.json({ ok: true, cleared, queue: [] });
});

// --- HTTP API --------------------------------------------------------

// Resolve a URL via yt-dlp
app.post("/api/resolve", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  try {
    const result = await ytdlp(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function buildDashSplitSource({ resolved, sourceUrl }) {
  resolved.isLive = false;
  resetDashSegmentSession();
  const pairId = `pair-${Date.now()}`;
  const videoProxyId = proxyRegister(resolved.videoUrl, resolved.videoHeaders, {
    originalUrl: sourceUrl, pairId, role: "video",
  });
  const audioProxyId = proxyRegister(resolved.audioUrl, resolved.audioHeaders, {
    originalUrl: sourceUrl, pairId, role: "audio",
  });
  const videoInfo = await probeMP4Structure(videoProxyId);
  const audioInfo = await probeMP4Structure(audioProxyId);
  log.info({
    video: { init: videoInfo.initEnd, segs: videoInfo.segments.length, mb: Math.round(videoInfo.totalSize / 1048576) },
    audio: { init: audioInfo.initEnd, segs: audioInfo.segments.length, mb: Math.round(audioInfo.totalSize / 1048576) },
  }, "DASH probe complete");
  const dashHls = generateDashHls(
    pairId,
    resolved.videoFormat, resolved.audioFormat,
    videoProxyId, audioProxyId,
    videoInfo, audioInfo,
  );
  if (dashHls) {
    dashHlsSessions.set(pairId, { ...dashHls, createdAt: Date.now(), lastAccessAt: Date.now() });
  }
  const mediaSource = dashHls
    ? { type: "hls", url: `/api/dash/hls/${pairId}/master.m3u8` }
    : {
        type: "split-mp4",
        videoUrl: `/api/proxy?id=${videoProxyId}`,
        audioUrl: `/api/proxy?id=${audioProxyId}`,
      };
  return {
    playerUrl: mediaSource.url || mediaSource.videoUrl,
    mediaSource,
  };
}

async function buildDashSplitTranscodeAndPlayerUrl({ resolved }) {
  resolved.isLive = false;
  const session = startTranscodePipeline(resolved.videoUrl, resolved.audioUrl, {
    videoHeaders: resolved.videoHeaders,
    audioHeaders: resolved.audioHeaders,
  });
  const ready = await waitForTranscodePlaylist(session.playlistPath, { timeoutMs: DASH_TRANSCODE_STARTUP_TIMEOUT_MS, pollMs: 150 });
  if (ready.ready) {
    log.info({ sessionId: session.sessionId, segmentCount: ready.segmentCount }, "DASH transcode ready for playback");
    return "/api/transcode/playlist.m3u8";
  }
  if (!transcodeState.process) {
    throw new Error("Transcode exited before playlist was ready");
  }
  throw new Error("DASH transcode did not produce init.mp4 and media segments within the startup window");
}

async function playUrlNow({ url, transcode: transcodeEnabled } = {}) {
  if (!url) {
    const err = new Error("url required");
    err.status = 400;
    throw err;
  }
  const shouldTranscode = transcodeEnabled !== false && String(transcodeEnabled).toLowerCase() !== "false" && DASH_TRANSCODE;

  if (!playerWs || playerWs.readyState !== 1) {
    const err = new Error("No player connected. Open the player in Tesla browser first.");
    err.status = 503;
    throw err;
  }

  updateState({ status: "resolving", url });

  // Check if it's already a direct stream URL
  const directPattern = /\.(m3u8|mp4|flv|ts|webm)(\?|$)/i;
  let resolved;

  if (directPattern.test(url)) {
    resolved = { url, title: url, isLive: false, type: /\.m3u8/i.test(url) ? "hls" : "direct", subtitles: [] };
  } else {
    resolved = await ytdlp(url);
  }

  let playerUrl;
  let mediaSource;

  if (resolved.type === "dash_split") {
    if (shouldTranscode) {
      try {
        playerUrl = await buildDashSplitTranscodeAndPlayerUrl({ resolved });
        mediaSource = { type: "hls", url: playerUrl };
        log.info({ url }, "Using DASH split ffmpeg transcode path");
      } catch (err) {
        log.error({ err: err.message }, "DASH transcode pipeline failed, falling back to fMP4 HLS");
        await killPipeline();
        const dashSplit = await buildDashSplitSource({ resolved, sourceUrl: url });
        playerUrl = dashSplit.playerUrl;
        mediaSource = dashSplit.mediaSource;
      }
    } else {
      log.info({ url }, "DASH split transcode disabled for this request");
      const dashSplit = await buildDashSplitSource({ resolved, sourceUrl: url });
      playerUrl = dashSplit.playerUrl;
      mediaSource = dashSplit.mediaSource;
      await killPipeline();
    }
  } else if (resolved.type === "hls") {
    resetDashSegmentSession();
    const id = proxyRegister(resolved.url);
    playerUrl = `/api/proxy/hls?id=${id}`;
    mediaSource = { type: "hls", url: playerUrl };
    await killPipeline();
  } else {
    resetDashSegmentSession();
    const id = proxyRegister(resolved.url);
    playerUrl = `/api/proxy?id=${id}`;
    mediaSource = { type: "mp4", url: playerUrl };
    await killPipeline();
  }

  // Subtitles — check cache first, download if missing
  currentSubtitles = [];
  if (resolved.subtitles?.length && !directPattern.test(url)) {
    const cacheKey = subsCacheKey(url);
    const cached = getCachedSubs(url);

    const broadcastSubs = (subs, cacheK) => {
      currentSubtitles = subs;
      currentSubsCacheKey = cacheK;
      if (subs.length) {
        broadcast({
          type: "subtitlesAvailable",
          subtitles: subs.map((s) => ({
            lang: s.lang, name: s.name, auto: s.auto,
            url: `/api/subs/${cacheK}/${s.filename}`,
          })),
        });
      }
    };

    if (cached) {
      log.debug({ cacheKey, count: cached.subs.length }, "Subtitle cache hit");
      // Delay broadcast so it arrives after the "play" message
      setTimeout(() => broadcastSubs(cached.subs, cacheKey), 500);
    } else {
      const subsDir = resolve(SUBS_CACHE_DIR, cacheKey);
      const wantedPrefixes = ["en", "zh"];
      const selected = resolved.subtitles.filter((s) => {
        const base = s.lang.split("-")[0].toLowerCase();
        return wantedPrefixes.includes(base);
      });
      // Direct fetch from URLs already in yt-dlp JSON — no second yt-dlp call
      downloadSubtitlesDirect(selected, subsDir).then((downloaded) => {
        log.info({ cacheKey, count: downloaded.length }, "Subtitles cached");
        broadcastSubs(downloaded, cacheKey);
      }).catch((e) => log.error({ err: e.message }, "Subtitle download error"));
    }
  }

  updateState({
    status: "playing",
    resolvedUrl: resolved.url || resolved.videoUrl,
    title: resolved.title,
    isLive: resolved.isLive,
  });

  const thumbUrl = resolved.thumbnail ? `/api/thumb?url=${encodeURIComponent(resolved.thumbnail)}` : null;

  // Look up saved progress from history
  const history = loadHistory();
  const savedEntry = history.find((h) => h.url === url);
  const startTime = savedEntry?.progress || 0;

  broadcast({
    type: "play",
    url: playerUrl,
    mediaSource,
    sourceUrl: url,
    title: resolved.title,
    isLive: resolved.isLive,
    thumbnail: thumbUrl,
    duration: resolved.duration,
    startTime,
  });

  addToHistory({
    title: resolved.title,
    url,
    thumbnail: thumbUrl,
    duration: resolved.duration,
    progress: startTime, // preserve saved progress until player reports new position
  });

  return { ok: true, title: resolved.title, isLive: resolved.isLive };
}

// Play a URL (resolve + push to player)
app.post("/api/play", async (req, res) => {
  try {
    res.json(await playUrlNow(req.body));
  } catch (e) {
    updateState({ status: "idle" });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Playback control
app.post("/api/control", async (req, res) => {
  const { action } = req.body;
  if (!["pause", "resume", "stop"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  if (action === "stop") {
    await killPipeline();
    resetDashSegmentSession();
    currentSubtitles = [];
    updateState({ status: "idle", url: null, resolvedUrl: null, title: null });
  }

  if (!playerWs || playerWs.readyState !== 1) {
    return res.json({ ok: true, status: state.status });
  }
  if (action === "pause") updateState({ status: "paused" });
  if (action === "resume") updateState({ status: "playing" });

  broadcast({ type: action });
  res.json({ ok: true, status: state.status });
});

// --- Dev tools -------------------------------------------------------

app.post("/api/dev/reload", (_req, res) => {
  broadcast({ type: "reload" });
  res.json({ ok: true });
});

// Tesla controls debug log
const devLog = [];
const playerLog = [];
app.post("/api/dev/log", (req, res) => {
  const entry = { ...req.body, serverTs: Date.now() };
  devLog.push(entry);
  if (devLog.length > 200) devLog.shift();
  log.debug({ src: "tesla" }, entry.msg);
  res.json({ ok: true });
});
app.post("/api/dev/decode-log", (req, res) => {
  log.info({ decode: req.body }, "Player decode path report");
  res.json({ ok: true });
});
app.post("/api/dev/stutter-log", (req, res) => {
  latestStutterLog = { ...req.body, receivedAt: Date.now() };
  log.info({ stutter: latestStutterLog }, "Player stutter telemetry report");
  res.json({ ok: true });
});
app.post("/api/dev/player-log", (req, res) => {
  const receivedAt = Date.now();
  const entries = Array.isArray(req.body) ? req.body : [req.body];
  for (const item of entries) {
    const entry = { ...item, receivedAt };
    playerLog.push(entry);
    if (playerLog.length > 50) playerLog.shift();
    log.info({ playerLog: entry }, "Player runtime log");
  }
  res.json({ ok: true });
});
app.get("/api/dev/log", (_req, res) => {
  res.json(devLog);
});
app.get("/api/dev/stutter-log", (_req, res) => {
  res.json(latestStutterLog || null);
});
app.get("/api/dev/player-log", (_req, res) => {
  res.json(playerLog);
});

app.get("/api/dev/player", (_req, res) => {
  res.json(playerState);
});

app.post("/api/metrics/player", (req, res) => {
  latestPlayerMetrics = { ...req.body, updatedAt: Date.now() };
  res.json({ ok: true });
});

app.get("/api/metrics", (_req, res) => {
  res.json(getMetricsSnapshot());
});

app.delete("/api/cache", (_req, res) => {
  try {
    rmSync(SEGMENT_CACHE_DIR, { recursive: true, force: true });
    mkdirSync(SEGMENT_CACHE_DIR, { recursive: true });
    segmentCacheState.sizeBytes = 0;
    segmentCacheState.hits = 0;
    segmentCacheState.misses = 0;
    segmentCacheState.logicalKeyHits = 0;
    segmentCacheState.hashKeyHits = 0;
    segmentCacheState.prefetchCount = 0;
    segmentCacheState.coalescedRequests = 0;
    segmentCacheState.integrityFailures = 0;
    segmentCacheState.retryCount = 0;
    segmentCacheState.evictionCount = 0;
    segmentCachePrefetchQueue.length = 0;
    segmentCachePrefetchSet.clear();
    segmentCachePrefetchActive = 0;
    segmentCacheHealthSnapshot = {
      hits: 0,
      misses: 0,
    };
    if (segmentCacheEvictionTimer) {
      clearTimeout(segmentCacheEvictionTimer);
      segmentCacheEvictionTimer = null;
    }
    res.json({ ok: true, cleared: true, path: SEGMENT_CACHE_DIR });
  } catch (err) {
    log.error({ err: err?.message }, "Failed to clear segment cache");
    res.status(500).json({ error: "Failed to clear segment cache" });
  }
});

// Current status
app.get("/api/status", (_req, res) => {
  const queue = listQueue();
  const playlists = listPlaylists();
  res.json({
    ...state,
    playerConnected: !!(playerWs && playerWs.readyState === 1),
    player: playerState,
    queue,
    queueLength: queue.length,
    playlists,
    playlistCount: playlists.length,
  });
});

// --- WebSocket -------------------------------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Ping all clients every 30s to keep connections alive through Cloudflare Tunnel
const WS_PING_INTERVAL = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
WS_PING_INTERVAL.unref();

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const role = new URL(req.url, "http://localhost").searchParams.get("role");

  if (role === "player") {
    playerWs = ws;
    log.info("Player WebSocket connected");

    // Reset state when player reconnects — old playback context is lost
    updateState({ status: "idle", url: null, resolvedUrl: null, title: null, isLive: false });
    ws.send(JSON.stringify({ type: "queueUpdated", queue: listQueue() }));
    ws.send(JSON.stringify({ type: "playlistsUpdated", playlists: listPlaylists() }));

    ws.on("close", () => {
      log.info("Player WebSocket disconnected");
      if (playerWs === ws) playerWs = null;
    });
  }

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      // Player reports status changes
      if (msg.type === "status" && msg.status) {
        updateState({ status: msg.status });
      } else if (msg.type === "playerState") {
        playerState = { currentTime: msg.currentTime, duration: msg.duration, isPlaying: msg.isPlaying, isMuted: msg.isMuted, updatedAt: Date.now() };
        // Save progress for non-Plex content to history
        if (!msg.plexRatingKey && state.url) {
          const history = loadHistory();
          const entry = history.find((h) => h.url === state.url);
          if (entry) {
            // Mark watched at 90% (same threshold as Plex)
            const nearEnd = msg.duration > 0 && msg.currentTime >= msg.duration * 0.9;
            if (nearEnd && !entry._markedWatched) {
              entry.viewCount = (entry.viewCount || 0) + 1;
              entry._markedWatched = true;
            }
            if (!nearEnd) entry._markedWatched = false;
            entry.progress = (nearEnd || msg.currentTime <= 5) ? 0 : Math.floor(msg.currentTime);
            saveHistory(history);
          }
        }
      } else if (msg.type === "pong") {
        ws.lastPong = Date.now();
      } else if (msg.type === "ended") {
        playNextFromQueue().then((result) => {
          if (!result) updateState({ status: "idle" });
        }).catch((err) => {
          log.error({ err: err?.message || String(err) }, "Failed to autoplay next queue item");
          updateState({ status: "idle" });
        });
      }
    } catch {}
  });
});

// Application-level heartbeat (25s — under Cloudflare's 100s timeout)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  });
}, 25_000).unref();

// --- Health endpoint --------------------------------------------------

const startedAt = Date.now();
let activeConnections = 0;
app.use((req, res, next) => {
  activeConnections++;
  res.once("close", () => activeConnections--);
  next();
});

app.get("/api/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: isShuttingDown ? "shutting_down" : "ok",
    uptime: Math.floor(process.uptime()),
    startedAt: new Date(startedAt).toISOString(),
    memory: {
      rssMB: Math.round(mem.rss / 1048576),
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
    },
    connections: { http: activeConnections, websocket: wss.clients.size },
    pipeline: { ytdlp: !!ytdlpProc, ffmpeg: !!ffmpegProc, hlsActive: !!currentHlsDir },
    proxy: { entries: proxyMap.size, dashMaps: dashSegmentMaps.size },
    player: { connected: !!(playerWs?.readyState === 1), status: state.status },
  });
});


// SPA fallback — serve index.html for client-side routes (/play, /show/:id)
const spaIndexPath = resolve(serveDist ? playerDist : playerSrc, "index.html");
app.get(/^\/(play|show\/\d+)/, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(spaIndexPath);
});

// --- Diagnostics upload ----------------------------------------------

const DIAG_DIR = resolve(__dirname, "../.diag-reports");
mkdirSync(DIAG_DIR, { recursive: true });

app.post("/api/diag", (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: "empty" });
  const filename = `diag-${Date.now()}.json`;
  writeFileSync(resolve(DIAG_DIR, filename), JSON.stringify(data, null, 2));
  log.info({ filename }, "Diagnostic report saved");
  res.json({ ok: true, filename });
});

// --- Start -----------------------------------------------------------

let isShuttingDown = false;

process.on("unhandledRejection", (err) => {
  log.error({ err: err?.message, stack: err?.stack }, "Unhandled rejection");
});
process.on("uncaughtException", (err) => {
  log.fatal({ err: err?.message, stack: err?.stack }, "Uncaught exception");
});

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info({ signal }, "Shutting down gracefully");
  broadcast({ type: "serverShutdown" });
  await killPipeline();
  wss.clients.forEach((ws) => { try { ws.close(1001, "Server shutting down"); } catch {} });
  server.close(() => {
    log.info("All connections drained, exiting");
    process.exit(0);
  });
  setTimeout(() => { log.error("Forced exit after 10s timeout"); process.exit(1); }, 10_000).unref();
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

initializeSegmentCache();

server.listen(PORT, () => {
  log.info({ port: PORT }, "Drive-In server started");
});
