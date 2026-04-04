import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { execFile, execSync, spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import pinoHttp from "pino-http";
import httpProxy from "http-proxy";
import log from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "9090", 10);
const PLEX_URL = process.env.PLEX_URL || "http://localhost:32400";
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

// COOP/COEP headers — required for SharedArrayBuffer (libmedia WebAssembly)
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

// Serve libmedia dist files
// Use local build (lib/libmedia) when available for DASH support, otherwise npm package
// libmedia dist: npm package for now; local build (lib/libmedia) available for DASH but needs version alignment
const libmediaDist = resolve(__dirname, "../node_modules/@libmedia/avplayer/dist/esm");
app.use("/lib/avplayer", express.static(libmediaDist));

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
// Current non-Plex subtitle tracks (from yt-dlp)
let currentSubtitles = []; // [{ lang, name, url, auto, filename }]
let currentSubsCacheKey = null;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

function updateState(patch) {
  Object.assign(state, patch);
}

// --- yt-dlp resolver -------------------------------------------------

// Prefer H.264 video + AAC audio for MPEG-TS compatibility
// Prefer 1080p30 H.264 + AAC — 60fps too heavy for Tesla WASM decoding.
const FORMAT_SELECTOR = "bv[vcodec^=avc1][height<=1080][fps<=30]+ba[acodec^=mp4a]/bv[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/bv[height<=1080][fps<=30]+ba*/bv[height<=1080]+ba*/b*";

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
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error("Failed to parse yt-dlp output")); }
      }
    );
  });
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
let currentHlsDir = null;

let ytdlpProc = null;

function killPipeline() {
  if (ytdlpProc) { ytdlpProc.kill("SIGTERM"); ytdlpProc = null; }
  if (ffmpegProc) { ffmpegProc.kill("SIGTERM"); ffmpegProc = null; }
  if (currentHlsDir) {
    try { rmSync(currentHlsDir, { recursive: true, force: true }); } catch {}
    currentHlsDir = null;
  }
}

function startPipeline(originalUrl, formatSelector) {
  killPipeline();

  const sessionId = `s-${Date.now()}`;
  currentHlsDir = resolve(hlsBase, sessionId);
  mkdirSync(currentHlsDir, { recursive: true });

  const hlsOutput = resolve(currentHlsDir, "stream.m3u8");

  // yt-dlp downloads + merges, pipes to ffmpeg for HLS segmentation
  const ytdlpArgs = [
    ...YTDLP_COMMON,
    "--no-warnings", "--no-playlist",
    "-f", formatSelector,
    "--merge-output-format", "mp4",
    "-o", "-",
    originalUrl,
  ];

  const ffmpegArgs = [
    "-hide_banner", "-loglevel", "warning",
    "-i", "pipe:0",
    "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_list_size", "0",
    "-hls_segment_filename", resolve(currentHlsDir, "seg%03d.ts"),
    hlsOutput,
  ];

  log.info("Pipeline starting: yt-dlp | ffmpeg");
  ytdlpProc = spawn("yt-dlp", ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpegProc = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

  // Pipe yt-dlp stdout → ffmpeg stdin
  ytdlpProc.stdout.pipe(ffmpegProc.stdin);

  ytdlpProc.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) log.debug({ src: "yt-dlp" }, msg);
  });
  ffmpegProc.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) log.debug({ src: "ffmpeg" }, msg);
  });

  ytdlpProc.on("close", (code) => {
    log.info({ exitCode: code }, "yt-dlp exited");
    ytdlpProc = null;
    // Close ffmpeg stdin so it finishes writing the last segments
    try { ffmpegProc?.stdin.end(); } catch {}
  });
  ffmpegProc.on("close", (code) => {
    log.info({ exitCode: code }, "ffmpeg exited");
    ffmpegProc = null;
    // Pipeline complete — HLS now has #EXT-X-ENDLIST, switch player to VOD mode
    broadcast({ type: "pipelineComplete" });
    log.info("Pipeline complete, notified player for VOD mode");
  });

  return hlsOutput;
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
  res.sendFile(filePath);
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

// --- DASH MPD generation (for YouTube/Bilibili split streams) --------

let currentDashMpd = null; // generated MPD XML string

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
  let sidxOffset = 0;
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
  if (sidxOffset && sidxOffset + 12 < buf.length) {
    const sidxSize = buf.readUInt32BE(sidxOffset);
    const version = buf[sidxOffset + 8];
    let off = sidxOffset + 12;
    // reference_ID (4) + timescale (4)
    off += 4; // reference_ID
    const timescale = buf.readUInt32BE(off); off += 4;
    // earliest_presentation_time + first_offset
    off += version === 0 ? 8 : 16;
    // reserved (2) + reference_count (2)
    off += 2;
    const referenceCount = buf.readUInt16BE(off); off += 2;

    let segStart = sidxOffset + sidxSize;
    for (let i = 0; i < referenceCount && off + 12 <= buf.length; i++) {
      const firstWord = buf.readUInt32BE(off);
      const referencedSize = firstWord & 0x7FFFFFFF;
      const subsegDuration = buf.readUInt32BE(off + 4);
      segments.push({
        start: segStart,
        end: segStart + referencedSize - 1,
        duration: subsegDuration / timescale,
      });
      segStart += referencedSize;
      off += 12;
    }
  }

  return { initEnd, segments, totalSize };
}

function generateMpd(videoFormat, audioFormat, duration, videoProxyId, audioProxyId, videoInfo, audioInfo) {
  const dur = duration || 0;
  const hours = Math.floor(dur / 3600);
  const mins = Math.floor((dur % 3600) / 60);
  const secs = dur % 60;
  const isoDuration = `PT${hours}H${mins}M${secs.toFixed(1)}S`;

  const vCodec = videoFormat.vcodec || "avc1.640028";
  const aCodec = audioFormat.acodec || "mp4a.40.2";
  const width = videoFormat.width || 1920;
  const height = videoFormat.height || 1080;
  const fps = videoFormat.fps || 30;
  const vBandwidth = Math.round((videoFormat.tbr || 2000) * 1000);
  const aBandwidth = Math.round((audioFormat.tbr || 128) * 1000);
  const asr = audioFormat.asr || 44100;

  // Must use full URL — libmedia's DASH BaseURL resolver concatenates (not path-resolves)
  const videoUrl = `http://localhost:${PORT}/api/proxy?id=${videoProxyId}`;
  const audioUrl = `http://localhost:${PORT}/api/proxy?id=${audioProxyId}`;

  function buildSegmentTemplate(info, proxyId) {
    if (!info.segments.length) return "";
    const mapId = `seg-${proxyId}`;
    dashSegmentMaps.set(mapId, { proxyId, initEnd: info.initEnd, segments: info.segments });
    const avgDur = info.segments.reduce((a, s) => a + s.duration, 0) / info.segments.length;
    const timescale = 1000;
    const segDurMs = Math.round(avgDur * 1000);
    // Use path-based URLs (no query params) to avoid &amp; XML escaping issues
    return `<SegmentTemplate timescale="${timescale}" duration="${segDurMs}"
                          initialization="api/dash/${mapId}/init.mp4"
                          media="api/dash/${mapId}/$Number$.mp4"
                          startNumber="0"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="${isoDuration}"
     minBufferTime="PT1.5S"
     profiles="urn:mpeg:dash:profile:full:2011">
  <BaseURL>http://localhost:${PORT}/</BaseURL>
  <Period duration="${isoDuration}">
    <AdaptationSet contentType="video" mimeType="video/mp4" startWithSAP="1" subsegmentAlignment="true">
      <Representation id="video" bandwidth="${vBandwidth}" codecs="${vCodec}"
                      width="${width}" height="${height}" frameRate="${fps}">
        ${buildSegmentTemplate(videoInfo, videoProxyId)}
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" startWithSAP="1" subsegmentAlignment="true">
      <Representation id="audio" bandwidth="${aBandwidth}" codecs="${aCodec}"
                      audioSamplingRate="${asr}">
        ${buildSegmentTemplate(audioInfo, audioProxyId)}
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

// DASH segment maps: mapId → { proxyId, initEnd, segments: [{start,end,duration}] }
const dashSegmentMaps = new Map();

// Serve DASH segments: /api/dash/:mapId/init.mp4 or /api/dash/:mapId/:number.mp4
app.get("/api/dash/:mapId/:segment", async (req, res) => {
  if (req.params.mapId === "manifest.mpd") return; // skip, handled below
  const map = dashSegmentMaps.get(req.params.mapId);
  if (!map) return res.status(404).json({ error: "Unknown segment map" });
  const entry = proxyMap.get(map.proxyId);
  if (!entry) return res.status(404).json({ error: "Proxy expired" });

  let rangeStr;
  const segName = req.params.segment.replace(".mp4", "");
  if (segName === "init") {
    rangeStr = `bytes=0-${map.initEnd}`;
  } else {
    const idx = parseInt(segName);
    if (isNaN(idx) || idx < 0) {
      return res.status(404).json({ error: "Segment not found" });
    }
    // Clamp to last segment if index is past end (rounding mismatch)
    const seg = map.segments[Math.min(idx, map.segments.length - 1)];
    rangeStr = `bytes=${seg.start}-${seg.end}`;
  }

  try {
    const headers = proxyHeaders(entry);
    headers["Range"] = rangeStr;
    const upstream = await fetchWithRetry(entry.url, { headers, redirect: "follow" }, { label: "dash-seg" });
    res.status(200);
    await pipeUpstream(upstream, req, res, { passStatus: false });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

app.get("/api/dash/manifest.mpd", (req, res) => {
  if (!currentDashMpd) return res.status(404).json({ error: "No DASH manifest" });
  // Replace localhost BaseURL with the actual request origin so tunnel/remote access works
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const origin = `${proto}://${host}`;
  const mpd = currentDashMpd.replaceAll(`http://localhost:${PORT}`, origin);
  res.set("Content-Type", "application/dash+xml");
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "no-cache");
  res.send(mpd);
});

// --- Stream proxy (bypass CORS) --------------------------------------

// Store resolved URLs for proxy lookup (with TTL cleanup)
const proxyMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of proxyMap) {
    if (now - v.ts > 3600_000) proxyMap.delete(k); // 1 hour TTL
  }
}, 60_000).unref();

function proxyRegister(url, headers = null, meta = {}) {
  const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  proxyMap.set(id, { url, ts: Date.now(), headers, ...meta });
  return id;
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
        e.ts = Date.now();
      }
    } else if (resolved.url) {
      entry.url = resolved.url;
      entry.ts = Date.now();
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

// --- Fetch with retry (exponential backoff + jitter) -----------------

async function fetchWithRetry(url, options = {}, { retries = 3, label = "fetch" } = {}) {
  let lastResp, lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
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

async function pipeUpstream(upstream, req, res, { passStatus = true } = {}) {
  if (passStatus) res.status(upstream.status);
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  res.set("Access-Control-Allow-Origin", "*");

  const { Readable } = await import("stream");
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.pipe(res);
  nodeStream.on("error", () => { if (!res.writableEnded) res.end(); });
  req.on("close", () => nodeStream.destroy());
}

// Raw stream proxy (mp4, ts segments, etc.)
app.get("/api/proxy", async (req, res) => {
  const entry = proxyMap.get(req.query.id);
  if (!entry) return res.status(404).json({ error: "Unknown stream" });

  try {
    const headers = proxyHeaders(entry);
    if (req.headers.range) headers["Range"] = req.headers.range;
    let upstream = await fetchWithRetry(entry.url, { headers, redirect: "follow" }, { label: "proxy" });
    // Re-resolve expired CDN URLs on persistent 403
    if (upstream.status === 403 && entry.originalUrl) {
      await upstream.body?.cancel();
      if (await reResolveProxy(req.query.id)) {
        const freshEntry = proxyMap.get(req.query.id);
        const freshHeaders = proxyHeaders(freshEntry);
        if (req.headers.range) freshHeaders["Range"] = req.headers.range;
        upstream = await fetchWithRetry(freshEntry.url, { headers: freshHeaders, redirect: "follow" }, { label: "proxy-reresolved" });
      }
    }
    await pipeUpstream(upstream, req, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// DASH segment proxy — serve a specific byte range from upstream
app.get("/api/proxy/range", async (req, res) => {
  const entry = proxyMap.get(req.query.id);
  if (!entry) return res.status(404).json({ error: "Unknown stream" });
  const range = req.query.r;
  if (!range) return res.status(400).json({ error: "range required" });

  try {
    const headers = proxyHeaders(entry);
    headers["Range"] = `bytes=${range}`;
    const upstream = await fetchWithRetry(entry.url, { headers, redirect: "follow" }, { label: "proxy/range" });
    res.status(200); // Always 200 for DASH segment fetches
    await pipeUpstream(upstream, req, res, { passStatus: false });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// HLS proxy — fetch m3u8 and rewrite all URLs to go through our proxy
app.get("/api/proxy/hls", async (req, res) => {
  const entry = proxyMap.get(req.query.id);
  if (!entry) return res.status(404).json({ error: "Unknown stream" });

  try {
    const upstream = await fetch(entry.url, { headers: proxyHeaders(entry), redirect: "follow" });
    let body = await upstream.text();
    const baseUrl = new URL(entry.url);

    // Rewrite each non-comment, non-empty line
    body = body.replace(/^(?!#)(\S+.*)$/gm, (match, line) => {
      const trimmed = line.trim();
      if (!trimmed) return match;

      const absUrl = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).href;
      const isM3u8 = /\.m3u8?(\?|$)/i.test(absUrl);
      const id = proxyRegister(absUrl);
      return isM3u8 ? `/api/proxy/hls?id=${id}` : `/api/proxy?id=${id}`;
    });

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(body);
  } catch (e) {
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
    protocol: "dash",
    fastSeek: "1",
    directPlay: "0",
    directStream: "1",
    directStreamAudio: "1",
    videoResolution: "1920x1080",
    maxVideoBitrate: "8000",
    subtitleSize: "100",
    subtitles: subtitleStreamID ? "burn" : "none",
    audioBoost: "700",
    location: "lan",
    addDebugOverlay: "0",
    autoAdjustQuality: "0",
    autoAdjustSubtitle: "0",
    mediaBufferSize: "102400",
    ...(audioStreamID ? { audioStreamID } : {}),
    session,
    "X-Plex-Incomplete-Segments": "1",
    "X-Plex-Client-Identifier": "drive-in-player",
    "X-Plex-Product": "Drive-In",
    "X-Plex-Features": "external-media,indirect-media,hub-style-list",
    "X-Plex-Platform": "Chrome",
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
  // Store DASH start URL for manifest proxy
  plexDashMpdUrl = `${PLEX_URL}/video/:/transcode/universal/start.mpd?${params}`;
  return `/api/plex/dash/manifest.mpd`;
}

// --- Plex DASH proxy (http-proxy for low-overhead streaming) ---------
let plexDashMpdUrl = null;
const plexProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  followRedirects: true,
  ws: true,
});
plexProxy.on("error", (err, _req, res) => {
  log.error({ err: err.message }, "[plex-proxy] error");
  if (res.writeHead) res.writeHead(502).end();
});

app.get("/api/plex/dash/manifest.mpd", async (req, res) => {
  if (!plexDashMpdUrl) return res.status(404).json({ error: "No active Plex transcode" });
  try {
    const mpdRes = await fetch(plexDashMpdUrl);
    if (!mpdRes.ok) return res.status(mpdRes.status).json({ error: `Plex MPD ${mpdRes.status}` });
    let body = await mpdRes.text();
    body = body.replace(/\/video\/:\/transcode\/universal\//g, "/api/plex/dash/");
    res.set("Content-Type", "application/dash+xml");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(body);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

app.use("/api/plex/dash/*path", (req, res) => {
  // Rewrite path back to Plex's original URL structure
  const plexPath = req.originalUrl.replace("/api/plex/dash/", "/video/:/transcode/universal/");
  req.url = `${plexPath}${plexPath.includes("?") ? "&" : "?"}X-Plex-Token=${PLEX_TOKEN}`;
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

app.post("/api/plex/play", async (req, res) => {
  const { ratingKey, subtitleStreamID, audioStreamID, offset } = req.body;
  if (!ratingKey) return res.status(400).json({ error: "ratingKey required" });
  if (!PLEX_TOKEN) return res.status(503).json({ error: "Plex token not configured" });
  if (!playerWs || playerWs.readyState !== 1) {
    return res.status(503).json({ error: "No player connected" });
  }

  updateState({ status: "resolving", url: `plex://${ratingKey}` });

  try {
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

    killPipeline();

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

    res.json({ ok: true, title });
  } catch (e) {
    updateState({ status: "idle" });
    res.status(500).json({ error: e.message });
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

// Proxy Plex thumbnails (so browser doesn't need token)
app.get("/api/plex/thumb", async (req, res) => {
  const path = req.query.path;
  if (!path || !PLEX_TOKEN) return res.status(400).end();
  try {
    const upstream = await fetch(`${PLEX_URL}${path}?X-Plex-Token=${PLEX_TOKEN}`);
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    const buf = Buffer.from(await upstream.arrayBuffer());
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
    return res.sendFile(cacheFile);
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
  if (!PLEX_TOKEN) return res.json(history);

  // Enrich Plex items with current viewOffset from Plex
  const plexKeys = history.filter((h) => h.plex?.ratingKey).map((h) => h.plex.ratingKey);
  if (!plexKeys.length) return res.json(history);

  try {
    const data = await plexApi(`/library/metadata/${plexKeys.join(",")}`);
    const metaMap = {};
    for (const m of data.MediaContainer?.Metadata || []) {
      metaMap[m.ratingKey] = { viewOffset: m.viewOffset || 0, viewCount: m.viewCount || 0 };
    }
    const enriched = history.map((h) => {
      if (h.plex?.ratingKey && metaMap[h.plex.ratingKey]) {
        return { ...h, ...metaMap[h.plex.ratingKey] };
      }
      return h;
    });
    res.json(enriched);
  } catch {
    res.json(history);
  }
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

// Play a URL (resolve + push to player)
app.post("/api/play", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  if (!playerWs || playerWs.readyState !== 1) {
    return res.status(503).json({ error: "No player connected. Open the player in Tesla browser first." });
  }

  updateState({ status: "resolving", url });

  try {
    // Check if it's already a direct stream URL
    const directPattern = /\.(m3u8|mp4|flv|ts|webm)(\?|$)/i;
    let resolved;

    if (directPattern.test(url)) {
      resolved = { url, title: url, isLive: false, type: /\.m3u8/i.test(url) ? "hls" : "direct", subtitles: [] };
    } else {
      resolved = await ytdlp(url);
    }

    let playerUrl;

    if (resolved.type === "dash_split") {
      killPipeline();
      // DASH: proxy video+audio streams separately, generate MPD for libmedia
      const pairId = `pair-${Date.now()}`;
      const videoProxyId = proxyRegister(resolved.videoUrl, resolved.videoHeaders, { originalUrl: url, pairId, role: "video" });
      const audioProxyId = proxyRegister(resolved.audioUrl, resolved.audioHeaders, { originalUrl: url, pairId, role: "audio" });
      // Sequential probes — some CDNs (Bilibili) reject concurrent range requests
      const videoInfo = await probeMP4Structure(videoProxyId);
      const audioInfo = await probeMP4Structure(audioProxyId);
      log.info({ video: { init: videoInfo.initEnd, segs: videoInfo.segments.length, mb: Math.round(videoInfo.totalSize / 1048576) }, audio: { init: audioInfo.initEnd, segs: audioInfo.segments.length, mb: Math.round(audioInfo.totalSize / 1048576) } }, "DASH probe complete");
      currentDashMpd = generateMpd(
        resolved.videoFormat, resolved.audioFormat,
        resolved.duration, videoProxyId, audioProxyId,
        videoInfo, audioInfo,
      );
      resolved.isLive = false;
      playerUrl = "/api/dash/manifest.mpd";
    } else if (resolved.type === "hls") {
      const id = proxyRegister(resolved.url);
      playerUrl = `/api/proxy/hls?id=${id}`;
    } else {
      const id = proxyRegister(resolved.url);
      playerUrl = `/api/proxy?id=${id}`;
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

    res.json({ ok: true, title: resolved.title, isLive: resolved.isLive });
  } catch (e) {
    updateState({ status: "idle" });
    res.status(500).json({ error: e.message });
  }
});

// Playback control
app.post("/api/control", (req, res) => {
  const { action } = req.body;
  if (!["pause", "resume", "stop"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  if (action === "stop") {
    killPipeline();
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
app.post("/api/dev/log", (req, res) => {
  const entry = { ...req.body, serverTs: Date.now() };
  devLog.push(entry);
  if (devLog.length > 200) devLog.shift();
  log.debug({ src: "tesla" }, entry.msg);
  res.json({ ok: true });
});
app.get("/api/dev/log", (_req, res) => {
  res.json(devLog);
});

app.get("/api/dev/player", (_req, res) => {
  res.json(playerState);
});

// Current status
app.get("/api/status", (_req, res) => {
  res.json({
    ...state,
    playerConnected: !!(playerWs && playerWs.readyState === 1),
    player: playerState,
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

// --- Start -----------------------------------------------------------

let isShuttingDown = false;

process.on("unhandledRejection", (err) => {
  log.error({ err: err?.message, stack: err?.stack }, "Unhandled rejection");
});
process.on("uncaughtException", (err) => {
  log.fatal({ err: err?.message, stack: err?.stack }, "Uncaught exception");
});

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info({ signal }, "Shutting down gracefully");
  broadcast({ type: "serverShutdown" });
  killPipeline();
  wss.clients.forEach((ws) => { try { ws.close(1001, "Server shutting down"); } catch {} });
  server.close(() => {
    log.info("All connections drained, exiting");
    process.exit(0);
  });
  setTimeout(() => { log.error("Forced exit after 10s timeout"); process.exit(1); }, 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

server.listen(PORT, () => {
  log.info({ port: PORT }, "Drive-In server started");
});
