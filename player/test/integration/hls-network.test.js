import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrefetcher,
  playlistBody,
  segment,
  waitFor,
} from "../helpers/hls-fixture.js";

test("a timed-out prefetch releases the queue for later segments", async (t) => {
  const requested = [];
  let firstSegmentAttempts = 0;
  const prefetcher = createPrefetcher({
    inactivityTimeoutMs: 10,
    maxRetries: 0,
    retryBaseDelayMs: 5,
    retryCycleMaxDelayMs: 10,
    fetchImpl: (url, { signal } = {}) => {
      requested.push(url);
      if (url.endsWith("/1.m4s") && firstSegmentAttempts++ === 0) {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(new Response(url.endsWith("/1.m4s") ? "one" : "two", {
        headers: { "content-type": "video/mp4" },
      }));
    },
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = "https://drivein.test/video.m3u8";
  const segments = [segment(0), segment(1), segment(2)];
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;

  prefetcher.scheduleAhead(playlistUrl, 1);
  await waitFor(() => prefetcher.getStats().readySegments === 2);

  const stats = prefetcher.getStats();
  assert.deepEqual(requested, [segments[1].url, segments[2].url, segments[1].url]);
  assert.equal(stats.activeDownloads, 0);
  assert.equal(stats.queuedSegments, 0);
  assert.equal(stats.retryWaitingSegments, 0);
  assert.equal(stats.timeoutCount, 1);
  assert.equal(stats.failureCount, 1);
  assert.equal(stats.completedDownloads, 2);
});

test("a foreground segment fails within the inactivity deadline", async (t) => {
  const prefetcher = createPrefetcher({
    inactivityTimeoutMs: 10,
    maxRetries: 0,
    retryBaseDelayMs: 5,
    fetchImpl: (_url, { signal } = {}) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = "https://drivein.test/video.m3u8";
  const segments = [segment(0)];
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);

  await assert.rejects(
    prefetcher.fetch(segments[0].url),
    (error) => error.code === "HLS_SEGMENT_FETCH_FAILED",
  );
  assert.equal(prefetcher.getStats().timeoutCount, 1);
});

test("a playlist request uses the same inactivity deadline as media", async (t) => {
  const prefetcher = createPrefetcher({
    inactivityTimeoutMs: 10,
    fetchImpl: (_url, { signal } = {}) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  t.after(() => prefetcher.destroy());

  await assert.rejects(
    prefetcher.fetch("https://drivein.test/video.m3u8"),
    /made no network progress/,
  );
  assert.equal(prefetcher.getStats().timeoutCount, 1);
  assert.match(prefetcher.getStats().lastFailure.error, /made no network progress/);
});

test("continuous body progress prevents a false inactivity timeout", async (t) => {
  const prefetcher = createPrefetcher({
    inactivityTimeoutMs: 10,
    maxRetries: 0,
    fetchImpl: async () => new Response(new ReadableStream({
      async start(controller) {
        for (const value of [1, 2, 3, 4]) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue(Uint8Array.of(value));
        }
        controller.close();
      },
    }), { headers: { "content-type": "video/mp4" } }),
  });
  t.after(() => prefetcher.destroy());
  const playlistUrl = "https://drivein.test/video.m3u8";
  const segments = [segment(0)];
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);

  const response = await prefetcher.fetch(segments[0].url);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(prefetcher.getStats().timeoutCount, 0);
});
