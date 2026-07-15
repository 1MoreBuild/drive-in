import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { Worker } from "worker_threads";
import { extname, resolve } from "path";

const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "srt", "subrip", "vtt", "webvtt"]);
const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
const SUBTITLE_CONVERSION_VERSION = 4;

async function localSubtitleStats(stream) {
  const path = stream?.file;
  if (!path || !TEXT_SUBTITLE_CODECS.has(extname(path).slice(1).toLowerCase())) return null;
  try {
    const stats = await stat(path, { bigint: true });
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function plexSubtitleVersionInfo(stream, { now = Date.now() } = {}) {
  const parts = [
    SUBTITLE_CONVERSION_VERSION,
    stream?.id,
    stream?.codec || stream?.format,
    stream?.key,
    stream?.updatedAt,
  ];
  const stats = await localSubtitleStats(stream);
  if (stats) {
    parts.push(stream.file, stats.size, stats.mtimeNs);
  } else {
    // Plex does not reliably expose validators for every remote/embedded text
    // stream. Revalidate these hourly instead of making them immutable forever.
    parts.push(`hour:${Math.floor(now / 3600_000)}`);
  }
  return {
    token: createHash("sha256").update(parts.map(String).join("\0")).digest("hex").slice(0, 16),
    immutable: !!stats,
  };
}

export async function plexSubtitleVersionToken(stream, options) {
  return (await plexSubtitleVersionInfo(stream, options)).token;
}

export function isPlexTextSubtitle(stream) {
  return TEXT_SUBTITLE_CODECS.has(String(stream?.codec || stream?.format || "").toLowerCase());
}

export async function readPlexSubtitleFile(stream) {
  const path = stream?.file;
  const stats = await localSubtitleStats(stream);
  if (!stats) return null;
  if (stats.size > BigInt(MAX_SUBTITLE_BYTES)) {
    throw new Error(`Subtitle file is too large (${stats.size} bytes)`);
  }
  return readFile(path);
}

export function decodeSubtitleBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    // Older Chinese subtitle collections are often GB18030/GBK encoded.
    return new TextDecoder("gb18030").decode(bytes).replace(/^\uFEFF/, "");
  }
}

function assTimestampToVtt(value) {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,3})$/);
  if (!match) return null;
  const milliseconds = match[4].padEnd(3, "0").slice(0, 3);
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}.${milliseconds}`;
}

function splitAssFields(line, fieldCount) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < fieldCount - 1; index += 1) {
    const comma = line.indexOf(",", start);
    if (comma === -1) return null;
    fields.push(line.slice(start, comma));
    start = comma + 1;
  }
  fields.push(line.slice(start));
  return fields;
}

function cleanAssText(text) {
  const lines = String(text)
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const classified = lines.map((line, index) => {
    const latinCount = (line.match(/\p{Script=Latin}/gu) || []).length;
    const hanCount = (line.match(/\p{Script=Han}/gu) || []).length;
    return {
      line,
      index,
      kind: latinCount > hanCount ? "english" : hanCount > 0 ? "chinese" : "other",
    };
  });
  const isBilingual = classified.some((entry) => entry.kind === "english")
    && classified.some((entry) => entry.kind === "chinese");
  if (isBilingual) {
    const rank = { english: 0, chinese: 1, other: 2 };
    classified.sort((left, right) => rank[left.kind] - rank[right.kind] || left.index - right.index);
  }
  return classified.map((entry) => entry.line).join("\n");
}

function parseAssCues(ass) {
  const cues = [];
  let inEvents = false;
  let format = null;

  for (const rawLine of String(ass).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (line.startsWith("[") && !/^\[events\]$/i.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;

    const formatMatch = line.match(/^Format\s*:\s*(.+)$/i);
    if (formatMatch) {
      format = formatMatch[1].split(",").map((field) => field.trim().toLowerCase());
      continue;
    }

    const dialogueMatch = line.match(/^Dialogue\s*:\s*(.*)$/i);
    if (!dialogueMatch || !format?.length) continue;
    const values = splitAssFields(dialogueMatch[1], format.length);
    if (!values) continue;
    const cue = Object.fromEntries(format.map((field, index) => [field, values[index]]));
    const start = assTimestampToVtt(cue.start);
    const end = assTimestampToVtt(cue.end);
    const text = cleanAssText(cue.text);
    if (start && end && text) cues.push({ start, end, text });
  }

  return cues;
}

export function assToVtt(ass) {
  const cues = parseAssCues(ass);
  return `WEBVTT\n\n${cues.map((cue) => `${cue.start} --> ${cue.end}\n${cue.text}`).join("\n\n")}\n`;
}

export function srtToVtt(srt) {
  return `WEBVTT\n\n${String(srt)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

export function subtitleToVtt(stream, buffer) {
  const codec = String(stream?.codec || stream?.format || "").toLowerCase();
  const text = decodeSubtitleBuffer(buffer);
  let vtt;
  if (codec === "ass" || codec === "ssa") vtt = assToVtt(text);
  else if (codec === "srt" || codec === "subrip") vtt = srtToVtt(text);
  if (codec === "vtt" || codec === "webvtt") {
    vtt = /^WEBVTT\b/.test(text.trimStart()) ? text : `WEBVTT\n\n${text}`;
  }
  if (!vtt) throw new Error(`Unsupported text subtitle codec: ${codec || "unknown"}`);
  const hasCue = /(?:(?:\d+):)?\d{2}:\d{2}[.,]\d{3}\s*-->/m.test(vtt);
  if (!hasCue) throw new Error("Converted subtitle contains no timed cues");
  return vtt.replace(/\r\n?/g, "\n");
}

export function analyzeSubtitle(stream, buffer) {
  const codec = String(stream?.codec || stream?.format || "").toLowerCase();
  const decoded = decodeSubtitleBuffer(buffer);
  const sample = codec === "ass" || codec === "ssa"
    ? parseAssCues(decoded).map((cue) => cue.text).join("\n")
    : decoded;
  return {
    vtt: subtitleToVtt(stream, buffer),
    inferredLanguage: inferTextLanguage(sample),
  };
}

export function convertSubtitleInWorker(stream, buffer) {
  return new Promise((resolvePromise, rejectPromise) => {
    const bytes = Uint8Array.from(buffer);
    const worker = new Worker(new URL("./plex-subtitle-worker.js", import.meta.url), {
      execArgv: [],
      workerData: {
        stream: { codec: stream?.codec, format: stream?.format },
        buffer: bytes,
      },
      transferList: [bytes.buffer],
    });
    worker.once("message", (message) => {
      if (message?.error) rejectPromise(new Error(message.error));
      else resolvePromise(message);
    });
    worker.once("error", rejectPromise);
    worker.once("exit", (code) => {
      if (code !== 0) rejectPromise(new Error(`Subtitle worker exited with code ${code}`));
    });
  });
}

export class PlexSubtitleCache {
  constructor(cacheDir, {
    maxMemoryEntries = 64,
    maxMemoryBytes = 64 * 1024 * 1024,
    maxDiskEntries = 512,
    maxDiskBytes = 256 * 1024 * 1024,
    maxConcurrentConversions = 2,
    convert = convertSubtitleInWorker,
  } = {}) {
    this.cacheDir = cacheDir;
    this.maxMemoryEntries = maxMemoryEntries;
    this.maxMemoryBytes = maxMemoryBytes;
    this.maxDiskEntries = maxDiskEntries;
    this.maxDiskBytes = maxDiskBytes;
    this.maxConcurrentConversions = maxConcurrentConversions;
    this.convert = convert;
    this.memory = new Map();
    this.memoryBytes = 0;
    this.inFlight = new Map();
    this.activeConversions = 0;
    this.conversionWaiters = [];
    this.ready = mkdir(cacheDir, { recursive: true }).then(() => this.pruneDisk());
  }

  cacheKey(ratingKey, stream, version) {
    const safeRatingKey = String(ratingKey).replace(/[^a-z0-9_-]/gi, "_");
    const safeStreamId = String(stream.id).replace(/[^a-z0-9_-]/gi, "_");
    return `${safeRatingKey}-${safeStreamId}-${version}`;
  }

  remember(key, value) {
    const previous = this.memory.get(key);
    if (previous) this.memoryBytes -= previous.byteSize;
    this.memory.delete(key);
    this.memory.set(key, value);
    this.memoryBytes += value.byteSize;
    while (this.memory.size > this.maxMemoryEntries || this.memoryBytes > this.maxMemoryBytes) {
      const oldestKey = this.memory.keys().next().value;
      this.memoryBytes -= this.memory.get(oldestKey).byteSize;
      this.memory.delete(oldestKey);
    }
  }

  async pruneDisk() {
    const names = (await readdir(this.cacheDir)).filter((name) => name.endsWith(".vtt"));
    const entries = (await Promise.all(names.map(async (name) => {
      try {
        const stats = await stat(resolve(this.cacheDir, name));
        const metadataPath = resolve(this.cacheDir, name.replace(/\.vtt$/, ".json"));
        const metadataSize = await stat(metadataPath).then((value) => value.size).catch(() => 0);
        return { name, mtimeMs: stats.mtimeMs, size: stats.size + metadataSize };
      } catch {
        return null;
      }
    }))).filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs);

    let retainedBytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const shouldDelete = index >= this.maxDiskEntries || retainedBytes + entry.size > this.maxDiskBytes;
      if (!shouldDelete) {
        retainedBytes += entry.size;
        continue;
      }
      await Promise.all([
        unlink(resolve(this.cacheDir, entry.name)).catch(() => {}),
        unlink(resolve(this.cacheDir, entry.name.replace(/\.vtt$/, ".json"))).catch(() => {}),
      ]);
    }
  }

  async readDiskValue(key) {
    const vttPath = resolve(this.cacheDir, `${key}.vtt`);
    try {
      const [vtt, metadata] = await Promise.all([
        readFile(vttPath, "utf8"),
        readFile(resolve(this.cacheDir, `${key}.json`), "utf8")
          .then((value) => JSON.parse(value))
          .catch(() => ({})),
      ]);
      return {
        vtt,
        inferredLanguage: metadata.inferredLanguage || null,
        byteSize: Buffer.byteLength(vtt),
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeDiskValue(key, value) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    const vttPath = resolve(this.cacheDir, `${key}.vtt`);
    const metadataPath = resolve(this.cacheDir, `${key}.json`);
    const temporaryVttPath = `${vttPath}.${suffix}`;
    const temporaryMetadataPath = `${metadataPath}.${suffix}`;
    try {
      await Promise.all([
        writeFile(temporaryVttPath, value.vtt, "utf8"),
        writeFile(temporaryMetadataPath, JSON.stringify({ inferredLanguage: value.inferredLanguage }), "utf8"),
      ]);
      await rename(temporaryVttPath, vttPath);
      await rename(temporaryMetadataPath, metadataPath);
    } catch (error) {
      await Promise.all([
        unlink(temporaryVttPath).catch(() => {}),
        unlink(temporaryMetadataPath).catch(() => {}),
      ]);
      throw error;
    }
  }

  async runConversion(task) {
    if (this.activeConversions >= this.maxConcurrentConversions) {
      await new Promise((resolvePromise) => this.conversionWaiters.push(resolvePromise));
    }
    this.activeConversions += 1;
    try {
      return await task();
    } finally {
      this.activeConversions -= 1;
      this.conversionWaiters.shift()?.();
    }
  }

  async get(ratingKey, stream, loadBuffer, providedVersionInfo = null) {
    await this.ready;
    const versionInfo = providedVersionInfo || await plexSubtitleVersionInfo(stream);
    const version = versionInfo.token;
    const key = this.cacheKey(ratingKey, stream, version);
    const etag = `"drivein-subtitle-${version}"`;
    const memoryHit = this.memory.get(key);
    if (memoryHit) {
      this.remember(key, memoryHit);
      return { ...memoryHit, version, etag, immutable: versionInfo.immutable, source: "memory" };
    }

    const diskHit = await this.readDiskValue(key);
    if (diskHit) {
      const value = diskHit;
      this.remember(key, value);
      return { ...value, version, etag, immutable: versionInfo.immutable, source: "disk" };
    }

    if (this.inFlight.has(key)) {
      const value = await this.inFlight.get(key);
      return { ...value, version, etag, immutable: versionInfo.immutable, source: "coalesced" };
    }

    const conversion = (async () => {
      const buffer = await loadBuffer(stream);
      const analysis = await this.runConversion(() => this.convert(stream, buffer));
      const value = {
        vtt: analysis.vtt,
        inferredLanguage: analysis.inferredLanguage || null,
        byteSize: Buffer.byteLength(analysis.vtt),
      };
      await this.writeDiskValue(key, value);
      this.remember(key, value);
      await this.pruneDisk();
      return value;
    })();
    this.inFlight.set(key, conversion);
    try {
      const value = await conversion;
      return { ...value, version, etag, immutable: versionInfo.immutable, source: "converted" };
    } finally {
      this.inFlight.delete(key);
    }
  }
}

function isUnknownLabel(value) {
  return !value || /^unknown$/i.test(String(value).trim());
}

function inferTextLanguage(text) {
  const sample = String(text || "");
  const hasHan = /\p{Script=Han}/u.test(sample);
  const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample);
  const hasHangul = /\p{Script=Hangul}/u.test(sample);
  const hasLatin = /\p{Script=Latin}/u.test(sample);

  if (hasKana) return { language: "日本語", languageCode: "jpn", label: hasLatin ? "日英双语" : "日本語" };
  if (hasHangul) return { language: "한국어", languageCode: "kor", label: hasLatin ? "韩英双语" : "한국어" };
  if (hasHan) return { language: "中文", languageCode: "zho", label: hasLatin ? "中英双语" : "中文" };
  return null;
}

export function describePlexSubtitle(ratingKey, stream, buffer = null, {
  versionToken = null,
  inferredLanguage = null,
} = {}) {
  const codec = String(stream?.codec || stream?.format || "").toLowerCase();
  const textSubtitle = isPlexTextSubtitle(stream);
  const originalTitle = stream?.title || stream?.displayTitle || stream?.extendedDisplayTitle;
  let language = stream?.language;
  let languageCode = stream?.languageCode;
  let displayTitle = stream?.displayTitle || stream?.extendedDisplayTitle || originalTitle;

  if (textSubtitle && isUnknownLabel(displayTitle) && (inferredLanguage || buffer)) {
    let inferred = inferredLanguage;
    if (!inferred && buffer) {
      const decoded = decodeSubtitleBuffer(buffer);
      const sample = codec === "ass" || codec === "ssa"
        ? parseAssCues(decoded).map((cue) => cue.text).join("\n")
        : decoded;
      inferred = inferTextLanguage(sample);
    }
    if (inferred) {
      language = inferred.language;
      languageCode = inferred.languageCode;
      displayTitle = inferred.label;
    }
  }
  if (isUnknownLabel(displayTitle)) displayTitle = codec ? `Unknown (${codec.toUpperCase()})` : "Unknown";

  return {
    id: stream.id,
    codec,
    language,
    languageCode,
    title: isUnknownLabel(originalTitle) ? displayTitle : originalTitle,
    displayTitle,
    delivery: textSubtitle ? "external" : "burn",
    ...(textSubtitle && versionToken ? { url: `/api/plex/subtitle/${ratingKey}/${stream.id}?v=${versionToken}` } : {}),
  };
}

export async function resolvePlexSubtitleDelivery(descriptor, ensureExternalSubtitle) {
  if (!descriptor || descriptor.delivery !== "external") {
    return { subtitle: descriptor, burnSubtitleStreamID: descriptor?.id || null, fallback: false };
  }
  try {
    await ensureExternalSubtitle();
    return { subtitle: descriptor, burnSubtitleStreamID: null, fallback: false };
  } catch (error) {
    const { url: _url, ...burnSubtitle } = descriptor;
    return {
      subtitle: { ...burnSubtitle, delivery: "burn", fallbackReason: error.message },
      burnSubtitleStreamID: descriptor.id,
      fallback: true,
      error,
    };
  }
}
