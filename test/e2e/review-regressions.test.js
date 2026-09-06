import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { chromium } from "playwright";
import { connectPlayer, postJson, startDriveInServer } from "./helpers.js";

const exec = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function origin(t, handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function pageFor(t, baseUrl) {
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined),
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  await page.goto(baseUrl);
  await page.waitForFunction(async () => (await import("/src/state.js")).state.ws?.readyState === 1);
  return page;
}

async function mediaOrigin(t, dir, { hls = false, videoSeconds = 5, audioSeconds = 2 } = {}) {
  const filename = hls ? "short.m3u8" : "short.webm";
  await exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${videoSeconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${audioSeconds}`,
    ...(hls
      ? ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-f", "hls", "-hls_time", "6", "-hls_segment_type", "fmp4"]
      : ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus"]),
    resolve(dir, filename),
  ]);
  const url = await origin(t, async (req, res) => {
    const name = new URL(req.url, "http://fixture").pathname.split("/").at(-1);
    try {
      const body = await readFile(resolve(dir, name));
      res.setHeader("Content-Type", name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : hls ? "video/mp4" : "video/webm");
      res.setHeader("Accept-Ranges", "bytes");
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
        if (start > end) { res.writeHead(416); res.end(); return; }
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": end - start + 1 });
        res.end(body.subarray(start, end + 1));
      } else res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return `${url}/${filename}`;
}

test("Plex supports explicit zero offset and remote embedded subtitles", async (t) => {
  const plex = await origin(t, (req, res) => {
    if (req.url.startsWith("/library/metadata/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ MediaContainer: { Metadata: [{
        title: "Remote", duration: 120_000, viewOffset: 60_000,
        Media: [{ Part: [{ id: "1", file: "/not-mounted-review-fixture/movie.mkv", Stream: [{ id: 10, streamType: 3, codec: "ass", index: 2 }] }] }],
      }] } }));
    } else if (req.url.includes("/start.m3u8")) {
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n/video/:/transcode/universal/session/fixture/base/index.m3u8\n');
    } else res.end("{}");
  });
  const { baseUrl } = await startDriveInServer(t, { PLEX_URL: plex });
  const player = await connectPlayer(baseUrl);
  t.after(() => player.close());
  for (const subtitleStreamID of [null, 10]) {
    const result = await postJson(baseUrl, "/api/plex/play", { ratingKey: "remote", offset: 0, subtitleStreamID });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const play = await player.next("play");
    assert.equal(play.startTime, 0);
    assert.equal(play.plex.subtitles[0].delivery, "burn");
    assert.equal(play.plex.subtitles[0].preparingExternal, undefined);
  }
  await postJson(baseUrl, "/api/plex/play", { ratingKey: "remote" });
  assert.equal((await player.next("play")).startTime, 60);
  for (const offset of [-1, "0", {}]) {
    assert.equal((await postJson(baseUrl, "/api/plex/play", { ratingKey: "remote", offset })).response.status, 400);
  }
});

test("HLS segment cache isolates origins, query identities and byte ranges", async (t) => {
  const a = await origin(t, (_req, res) => { res.setHeader("Content-Type", "video/mp2t"); res.end(Buffer.alloc(32768, 65)); });
  let hits = 0;
  const b = await origin(t, (req, res) => {
    hits++;
    const value = req.url.includes("variant=2") ? 67 : 66;
    res.setHeader("Content-Type", "video/mp2t");
    if (req.headers.range) res.writeHead(206, { "Content-Range": "bytes 100-199/32768" });
    res.end(Buffer.alloc(req.headers.range ? 100 : 32768, value));
  });
  const { baseUrl } = await startDriveInServer(t);
  const player = await connectPlayer(baseUrl);
  t.after(() => player.close());
  for (const [url, range, value, size] of [
    [`${a}/seg0.ts`, null, 65, 32768],
    [`${b}/seg0.ts`, null, 66, 32768],
    [`${b}/seg0.ts`, "bytes=100-199", 66, 100],
    [`${b}/seg0.ts?variant=2`, null, 67, 32768],
  ]) {
    await postJson(baseUrl, "/api/play", { url });
    const play = await player.next("play");
    const response = await fetch(new URL(play.url, baseUrl), { headers: range ? { Range: range } : {} });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes[0], value);
    assert.equal(bytes.length, size);
    assert.equal(response.status, range ? 206 : 200);
    await delay(50); // Let the streamed cache metadata commit before next lookup.
  }
  assert.equal(hits, 3);
});

test("stop is delivered before a newer play while Plex cleanup is delayed", async (t) => {
  let startStop;
  let releaseStop;
  const stopStarted = new Promise((done) => { startStop = done; });
  const stopReleased = new Promise((done) => { releaseStop = done; });
  t.after(() => releaseStop());
  const plex = await origin(t, async (req, res) => {
    if (req.url.startsWith("/library/metadata/")) res.end(JSON.stringify({ MediaContainer: { Metadata: [{ title: "Old", duration: 120000, Media: [{ Part: [{ id: "1", Stream: [] }] }] }] } }));
    else if (req.url.includes("/start.m3u8")) res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n/video/:/transcode/universal/session/fixture/base/index.m3u8\n');
    else if (req.url.includes("/universal/stop")) { startStop(); await stopReleased; res.end("{}"); }
    else res.end("{}");
  });
  const { baseUrl } = await startDriveInServer(t, { PLEX_URL: plex });
  const player = await connectPlayer(baseUrl);
  t.after(() => player.close());
  await postJson(baseUrl, "/api/plex/play", { ratingKey: "old" });
  await player.next("play");
  const delivered = [];
  player.socket.on("message", (raw) => {
    const { type } = JSON.parse(raw);
    if (["play", "stop"].includes(type)) delivered.push(type);
  });
  const stopping = postJson(baseUrl, "/api/control", { action: "stop" });
  await stopStarted;
  assert.equal((await postJson(baseUrl, "/api/play", { url: "https://fixture.test/new.mp4" })).response.status, 200);
  await player.next("play");
  releaseStop();
  await stopping;
  await delay(100);
  assert.deepEqual(delivered, ["stop", "play"]);
});

test("late subtitles stay disabled and cannot overwrite a newer language selection", async (t) => {
  const { baseUrl } = await startDriveInServer(t);
  const page = await pageFor(t, baseUrl);
  // Ignore AbortSignal in the fixture fetch so the generation check is tested
  // independently of successful transport cancellation.
  const result = await page.evaluate(async () => {
    const subtitles = await import("/src/subtitles.js");
    const originalFetch = globalThis.fetch;
    const responses = [];
    globalThis.fetch = (input, init) => String(input).includes("fixture-sub")
      ? new Promise((done) => responses.push(done)) : originalFetch(input, init);
    const response = (text) => new Response(`WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n${text}\n`);
    try {
      const old = subtitles.loadSubtitleTrack("en", "/fixture-sub-old.vtt");
      subtitles.disableExternalSubtitle();
      responses.shift()(response("STALE"));
      await old;
      subtitles.renderSubtitle(1);
      const disabledText = document.getElementById("subtitle-overlay").textContent;
      const first = subtitles.loadSubtitleTrack("en", "/fixture-sub-first.vtt");
      const second = subtitles.loadSubtitleTrack("en", "/fixture-sub-second.vtt");
      responses[1](response("CURRENT"));
      await second;
      responses[0](response("OLD"));
      await first;
      subtitles.renderSubtitle(1);
      return { disabledText, selectedText: document.getElementById("subtitle-overlay").textContent };
    } finally { globalThis.fetch = originalFetch; }
  });
  assert.deepEqual(result, { disabledText: "", selectedText: "CURRENT" });
});

test("short HLS starts and completes in the real canvas player", async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const url = await mediaOrigin(t, runtimeDir, { hls: true, videoSeconds: 4, audioSeconds: 4 });
  const page = await pageFor(t, baseUrl);
  assert.equal((await postJson(baseUrl, "/api/play", { url })).response.status, 200);
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getCurrentTime() > 0.5, null, { timeout: 15000 });
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getStatus() === "ended", null, { timeout: 15000 });
});

test("DASH split and ffmpeg fallback both play real media, including initialization segments", { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "drive-in-dash-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = resolve(dir, "yt-dlp");
  const infoPath = resolve(dir, "info.json");
  // Replace only external discovery. FFmpeg, HTTP proxying, MP4 probing,
  // playlist generation, decoding, and Canvas presentation remain real.
  await writeFile(tool, `#!${process.execPath}\nif (process.argv.includes('--cookies-from-browser')) process.exit(2);\nprocess.stdout.write(require('node:fs').readFileSync(process.env.YTDLP_FIXTURE_INFO));\n`);
  await chmod(tool, 0o755);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-movflags", "+dash+global_sidx", resolve(dir, "video.mp4")]);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-vn", "-c:a", "aac", "-movflags", "+dash+global_sidx", resolve(dir, "audio.mp4")]);
  const media = await origin(t, async (req, res) => {
    const name = new URL(req.url, "http://fixture").pathname.split("/").at(-1);
    const body = await readFile(resolve(dir, name));
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(range?.[2] ? Number(range[2]) : body.length - 1, body.length - 1);
    if (start > end) { res.writeHead(416); res.end(); return; }
    if (range) res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${body.length}` });
    res.end(body.subarray(start, end + 1));
  });
  await writeFile(infoPath, JSON.stringify({
    title: "DASH fixture", duration: 4,
    requested_formats: [
      { url: `${media}/video.mp4`, vcodec: "avc1.42c00d", acodec: "none", width: 320, height: 180, fps: 30 },
      { url: `${media}/audio.mp4`, vcodec: "none", acodec: "mp4a.40.2" },
    ],
  }));
  const { baseUrl } = await startDriveInServer(t, {
    PATH: `${dir}:${process.env.PATH}`, YTDLP_FIXTURE_INFO: infoPath, DASH_TRANSCODE: "1",
  });
  const page = await pageFor(t, baseUrl);
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  for (const transcode of [false, true]) {
    requests.length = 0;
    const result = await postJson(baseUrl, "/api/play", { url: "https://fixture.test/watch/dash", transcode });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getStatus() === "playing");
    const playlistPath = transcode ? "/api/transcode/playlist.m3u8" : "/api/dash/hls/";
    assert.ok(requests.some((url) => url.includes(playlistPath)), JSON.stringify(requests));
    await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getStatus() === "ended", null, { timeout: 15000 });
  }
});

test("Plex HLS proxy plays a remote fixture with inaccessible embedded subtitles", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "drive-in-plex-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mediaUrl = await mediaOrigin(t, dir, { hls: true, videoSeconds: 4, audioSeconds: 4 });
  const plex = await origin(t, async (req, res) => {
    if (req.url.startsWith("/library/metadata/")) {
      res.end(JSON.stringify({ MediaContainer: { Metadata: [{ title: "Remote fixture", duration: 4000, Media: [{ Part: [{ id: "1", file: "/not-mounted-review-fixture/movie.mkv", Stream: [{ id: 10, codec: "ass", streamType: 3, index: 2 }] }] }] }] } }));
    } else if (req.url.includes("/start.m3u8")) {
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n/video/:/transcode/universal/session/fixture/base/index.m3u8\n');
    } else if (req.url.includes("/session/fixture/")) {
      const name = new URL(req.url, "http://fixture").pathname.split("/").at(-1);
      const response = await fetch(name === "index.m3u8" ? mediaUrl : new URL(name, mediaUrl));
      res.setHeader("Content-Type", response.headers.get("Content-Type"));
      res.end(Buffer.from(await response.arrayBuffer()));
    } else res.end("{}");
  });
  const { baseUrl } = await startDriveInServer(t, { PLEX_URL: plex });
  const page = await pageFor(t, baseUrl);
  const result = await postJson(baseUrl, "/api/plex/play", { ratingKey: "remote", offset: 0 });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getCurrentTime() > 0.5, null, { timeout: 15000 });
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getStatus() === "ended", null, { timeout: 15000 });
});

test("a silent video tail advances, supports seeking back, and preserves mute on replacement", async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const url = await mediaOrigin(t, runtimeDir);
  const page = await pageFor(t, baseUrl);
  await postJson(baseUrl, "/api/play", { url });
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getCurrentTime() > 2.8);
  await page.evaluate(async () => {
    const player = globalThis.__driveInMediabunny.player;
    await player.seek(500);
  });
  await page.waitForFunction(() => {
    const player = globalThis.__driveInMediabunny?.player;
    return player?.clock.audioRing && player.getCurrentTime() > 0.7 && player.getCurrentTime() < 2;
  });
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getStatus() === "ended", null, { timeout: 15000 });
  await page.evaluate(async () => {
    const { state } = await import("/src/state.js");
    state.audioUnlocked = true;
    state.isMuted = true;
    state.player.setVolume(0);
    state.player.canvas.dataset.oldPlayer = "true";
  });
  await postJson(baseUrl, "/api/play", { url, autoplay: false });
  await page.waitForFunction(() => {
    const player = globalThis.__driveInMediabunny?.player;
    return player?.getStatus() === "paused" && !player.canvas.dataset.oldPlayer;
  });
  assert.deepEqual(await page.evaluate(async () => {
    const { state } = await import("/src/state.js");
    return { muted: state.isMuted, volume: state.player.volume, gain: state.player.gainNode.gain.value };
  }), { muted: true, volume: 0, gain: 0 });
});

test("paused recovery confirms readiness without waiting for playback progress", { timeout: 60000 }, async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const url = await mediaOrigin(t, runtimeDir);
  const page = await pageFor(t, baseUrl);
  let recoveryRequests = 0;
  page.on("request", (req) => { if (req.method() === "POST" && req.url().endsWith("/api/play")) recoveryRequests++; });
  await postJson(baseUrl, "/api/play", { url, autoplay: false });
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getStatus() === "paused");
  await page.evaluate(() => {
    const player = globalThis.__driveInMediabunny.player;
    player.canvas.dataset.oldPlayer = "true";
    player.fail(new Error("network fixture failure"));
  });
  await page.waitForFunction(() => {
    const player = globalThis.__driveInMediabunny?.player;
    return player?.getStatus() === "paused" && !player.canvas.dataset.oldPlayer;
  }, null, { timeout: 15000 });
  await delay(24000); // Exceed the 20-second confirmation timeout plus retry delay.
  assert.equal(recoveryRequests, 1);
  assert.equal(await page.evaluate(() => globalThis.__driveInMediabunny.player.getStatus()), "paused");
});
