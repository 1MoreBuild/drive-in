import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

import { chromium } from "playwright";

import { postJson, startDriveInServer, waitFor } from "./helpers.js";

const execFileAsync = promisify(execFile);
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function createMediaOrigin(t, runtimeDir) {
  const mediaPath = `${runtimeDir}/browser-e2e.webm`;
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "testsrc2=size=640x360:rate=60",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "4",
    "-c:v", "libvpx-vp9",
    "-deadline", "realtime",
    "-cpu-used", "8",
    "-b:v", "1M",
    "-c:a", "libopus",
    "-y",
    mediaPath,
  ]);
  const media = await readFile(mediaPath);
  const origin = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", "video/webm");
    if (!range) {
      response.setHeader("Content-Length", media.byteLength);
      response.end(media);
      return;
    }
    const start = Number(range[1]);
    const requestedEnd = range[2] ? Number(range[2]) : media.byteLength - 1;
    const end = Math.min(requestedEnd, media.byteLength - 1);
    if (start >= media.byteLength || end < start) {
      response.writeHead(416, { "Content-Range": `bytes */${media.byteLength}` });
      response.end();
      return;
    }
    const body = media.subarray(start, end + 1);
    response.writeHead(206, {
      "Content-Length": body.byteLength,
      "Content-Range": `bytes ${start}-${end}/${media.byteLength}`,
    });
    response.end(body);
  });
  await new Promise((resolveListen) => origin.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => {
    origin.closeAllConnections();
    origin.close(resolveClose);
  }));
  return `http://127.0.0.1:${origin.address().port}/browser-e2e.webm`;
}

test("the browser decodes media, paints the Canvas, and advances presentation time", async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const mediaUrl = await createMediaOrigin(t, runtimeDir);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.playerConnected;
  }, "browser player connection", 5_000);

  const playResponse = await postJson(baseUrl, "/api/play", {
    url: mediaUrl,
    startTime: 0,
    autoplay: true,
  });
  assert.equal(playResponse.response.status, 200);

  try {
    await page.waitForFunction(() => {
      const player = globalThis.__driveInMediabunny?.player;
      const stats = player?.getStats();
      return stats?.videoFrameRenderCount > 0 && stats.videoCurrentTime > 250;
    }, null, { timeout: 15_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      crossOriginIsolated: globalThis.crossOriginIsolated,
      hasSharedArrayBuffer: typeof SharedArrayBuffer === "function",
      statusText: document.body.innerText,
      playerStats: globalThis.__driveInMediabunny?.player?.getStats() || null,
    }));
    const runtimeLog = await fetch(new URL("/api/dev/player-log", baseUrl))
      .then((response) => response.json());
    throw new Error(`${error.message}\n${JSON.stringify({
      diagnostics,
      pageErrors,
      runtimeLog,
    }, null, 2)}`);
  }

  const rendered = await page.evaluate(() => {
    const player = globalThis.__driveInMediabunny.player;
    const canvas = document.querySelector('canvas[data-engine="mediabunny"]');
    return {
      currentTime: player.getCurrentTime(),
      stats: player.getStats(),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    };
  });
  assert.ok(rendered.currentTime > 0.25);
  assert.ok(rendered.stats.videoFrameRenderCount > 0);
  assert.deepEqual(rendered.canvas, { width: 640, height: 360 });
  assert.deepEqual(pageErrors, []);
});
