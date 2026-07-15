import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assToVtt,
  decodeSubtitleBuffer,
  describePlexSubtitle,
  isPlexTextSubtitle,
  PlexSubtitleCache,
  plexSubtitleVersionInfo,
  plexSubtitleVersionToken,
  resolvePlexSubtitleDelivery,
  subtitleToVtt,
} from "../plex-subtitles.js";

const bilingualAss = `\uFEFF[Script Info]
Title: Green Book

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:04.50,Default,,0,0,0,,{\\fs22\\fn宋体}纽约人民，大家好！\\N{\\r}Hello New York, everyone!
`;

test("ASS subtitles become plain multiline VTT cues", () => {
  const vtt = assToVtt(bilingualAss);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.200 --> 00:00:04\.500/);
  assert.match(vtt, /Hello New York, everyone!\n纽约人民，大家好！/);
  assert.doesNotMatch(vtt, /宋体|\\fs22|\{\\r\}/);
});

test("unknown bilingual ASS is labeled and delivered outside Plex transcode", () => {
  const stream = { id: 75307, streamType: 3, codec: "ass", displayTitle: "Unknown" };
  const buffer = Buffer.from(bilingualAss, "utf8");
  const subtitle = describePlexSubtitle("9147", stream, buffer, { versionToken: "0123456789abcdef" });
  assert.equal(isPlexTextSubtitle(stream), true);
  assert.equal(subtitle.language, "中文");
  assert.equal(subtitle.languageCode, "zho");
  assert.equal(subtitle.displayTitle, "中英双语");
  assert.equal(subtitle.delivery, "external");
  assert.equal(subtitle.url, "/api/plex/subtitle/9147/75307?v=0123456789abcdef");
});

test("PGS remains a Plex burn-in subtitle", () => {
  const subtitle = describePlexSubtitle("9147", {
    id: 75178,
    streamType: 3,
    codec: "pgs",
    language: "English",
    displayTitle: "English",
  });
  assert.equal(subtitle.delivery, "burn");
  assert.equal(subtitle.url, undefined);
});

test("UTF-8 BOM is removed before subtitle conversion", () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文", "utf8")]);
  assert.equal(decodeSubtitleBuffer(bytes), "中文");
  assert.match(subtitleToVtt({ codec: "srt" }, Buffer.from("1\n00:00:00,000 --> 00:00:01,000\n中文\n")), /00:00:00\.000/);
});

test("converted subtitles survive process cache recreation and invalidate with the source file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "drivein-subtitle-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, "movie.ass");
  const cacheDir = join(root, "cache");
  writeFileSync(sourcePath, bilingualAss);
  const stream = { id: 75307, streamType: 3, codec: "ass", file: sourcePath };
  let loadCount = 0;
  const load = () => {
    loadCount += 1;
    return readFileSync(sourcePath);
  };

  const firstCache = new PlexSubtitleCache(cacheDir);
  const first = await firstCache.get("9147", stream, load);
  const memoryHit = await firstCache.get("9147", stream, load);
  const restartedCache = new PlexSubtitleCache(cacheDir);
  const diskHit = await restartedCache.get("9147", stream, load);

  assert.equal(first.source, "converted");
  assert.equal(memoryHit.source, "memory");
  assert.equal(diskHit.source, "disk");
  assert.equal(loadCount, 1);
  assert.equal(diskHit.vtt, first.vtt);

  const oldVersion = await plexSubtitleVersionToken(stream);
  writeFileSync(sourcePath, `${bilingualAss}\n; source changed`);
  const newVersion = await plexSubtitleVersionToken(stream);
  const invalidated = await restartedCache.get("9147", stream, load);
  assert.notEqual(newVersion, oldVersion);
  assert.equal(invalidated.source, "converted");
  assert.equal(loadCount, 2);
});

test("cold concurrent requests share one conversion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "drivein-subtitle-coalesce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, "movie.ass");
  writeFileSync(sourcePath, bilingualAss);
  const stream = { id: 75307, codec: "ass", file: sourcePath };
  let loadCount = 0;
  const cache = new PlexSubtitleCache(join(root, "cache"));
  const load = async () => {
    loadCount += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    return readFileSync(sourcePath);
  };
  const [first, second] = await Promise.all([
    cache.get("9147", stream, load),
    cache.get("9147", stream, load),
  ]);
  assert.equal(loadCount, 1);
  assert.deepEqual(new Set([first.source, second.source]), new Set(["converted", "coalesced"]));
});

test("remote subtitle versions expire hourly instead of becoming immutable", async () => {
  const stream = { id: 9, codec: "vtt", key: "/library/streams/9" };
  const first = await plexSubtitleVersionInfo(stream, { now: 0 });
  const nextHour = await plexSubtitleVersionInfo(stream, { now: 3600_000 });
  assert.equal(first.immutable, false);
  assert.notEqual(first.token, nextHour.token);
});

test("failed external conversion falls back to Plex burn-in", async () => {
  const descriptor = {
    id: 75307,
    codec: "ass",
    delivery: "external",
    url: "/api/plex/subtitle/9147/75307?v=test",
  };
  const resolved = await resolvePlexSubtitleDelivery(descriptor, async () => {
    throw new Error("subtitle source unavailable");
  });
  assert.equal(resolved.fallback, true);
  assert.equal(resolved.burnSubtitleStreamID, 75307);
  assert.equal(resolved.subtitle.delivery, "burn");
  assert.equal(resolved.subtitle.url, undefined);
  assert.match(resolved.subtitle.fallbackReason, /unavailable/);
});

test("disk cache evicts by total bytes instead of entry count alone", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "drivein-subtitle-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");
  const convert = async () => ({
    vtt: `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${"x".repeat(160)}\n`,
    inferredLanguage: null,
  });
  const cache = new PlexSubtitleCache(cacheDir, { maxDiskBytes: 300, convert });

  for (const id of [1, 2]) {
    const file = join(root, `${id}.ass`);
    writeFileSync(file, bilingualAss);
    await cache.get("9147", { id, codec: "ass", file }, () => readFileSync(file));
  }

  assert.equal(readdirSync(cacheDir).filter((name) => name.endsWith(".vtt")).length, 1);
});
