import assert from "node:assert/strict";
import test from "node:test";

import { HlsSegmentPrefetcher } from "../src/engine/hls-segment-prefetcher.js";

globalThis.location = new URL("https://drivein.test/");

function segment(index, duration = 5) {
  return { url: `https://drivein.test/${index}.m4s`, duration };
}

function cachedEntry(body) {
  const bytes = new TextEncoder().encode(body).buffer;
  return {
    state: "ready",
    byteLength: bytes.byteLength,
    promise: Promise.resolve({
      bytes,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "video/mp4"]],
    }),
    controller: null,
    orphanedAt: null,
  };
}

test("buffer health stops at the first missing segment", () => {
  const prefetcher = new HlsSegmentPrefetcher();
  prefetcher.segments = [segment(0), segment(1), segment(2), segment(3)];
  prefetcher.segmentIndexes = new Map(prefetcher.segments.map((item, index) => [item.url, index]));
  prefetcher.currentIndex = 0;
  prefetcher.prefetches.set(segment(1).url, { state: "pending" });
  prefetcher.prefetches.set(segment(2).url, cachedEntry("two"));
  prefetcher.prefetches.set(segment(3).url, cachedEntry("three"));

  const stats = prefetcher.getStats();
  assert.equal(stats.bufferedAheadSeconds, 0);
  assert.equal(stats.readySegments, 0);
  assert.equal(stats.pendingSegments, 1);
});

test("playlist replacement preserves completed old-rendition segments", async () => {
  const prefetcher = new HlsSegmentPrefetcher();
  const oldUrl = segment("old").url;
  prefetcher.updatePlaylist(`#EXTM3U\n#EXTINF:5,\n${oldUrl}\n`, location.href);
  prefetcher.prefetches.set(oldUrl, cachedEntry("old rendition"));

  prefetcher.handleBitrateSwitch();
  prefetcher.updatePlaylist("#EXTM3U\n#EXTINF:5,\n/new.m4s\n", location.href);

  assert.equal(prefetcher.segmentIndexes.has(oldUrl), false);
  assert.equal(prefetcher.prefetches.get(oldUrl)?.state, "ready");
  const response = await prefetcher.fetch(oldUrl);
  assert.equal(await response.text(), "old rendition");
});

test("bitrate switch cancels unfinished old-rendition work", () => {
  const prefetcher = new HlsSegmentPrefetcher();
  const readyUrl = segment(1).url;
  const queuedUrl = segment(2).url;
  prefetcher.prefetches.set(readyUrl, cachedEntry("ready"));
  prefetcher.prefetches.set(queuedUrl, { state: "queued", controller: null });

  prefetcher.handleBitrateSwitch();

  assert.equal(prefetcher.awaitingPlaylistUpdate, true);
  assert.equal(prefetcher.prefetches.has(readyUrl), true);
  assert.equal(prefetcher.prefetches.has(queuedUrl), false);
});

test("seek resets HLS position and pending prefetches", () => {
  const prefetcher = new HlsSegmentPrefetcher();
  prefetcher.currentIndex = 20;
  prefetcher.currentUrl = segment(20).url;
  prefetcher.prefetches.set(segment(21).url, { state: "queued", controller: null });

  prefetcher.handleSeek();

  assert.equal(prefetcher.currentIndex, -1);
  assert.equal(prefetcher.currentUrl, null);
  assert.equal(prefetcher.prefetches.size, 0);
});

test("prefetch defaults target a 90-second in-car buffer", () => {
  const prefetcher = new HlsSegmentPrefetcher();
  assert.equal(prefetcher.targetAheadSeconds, 90);
  assert.equal(prefetcher.ahead, 36);
  assert.equal(prefetcher.maxBytes, 96 * 1024 * 1024);
  assert.equal(prefetcher.maxConcurrent, 1);
});

test("prefetch scheduling stops after reaching the time target", () => {
  const prefetcher = new HlsSegmentPrefetcher({
    ahead: 36,
    targetAheadSeconds: 12,
    maxConcurrent: 0,
  });
  prefetcher.segments = Array.from({ length: 10 }, (_, index) => segment(index, 4));

  prefetcher.scheduleAhead(1);

  assert.deepEqual(
    [...prefetcher.prefetches.values()].map((entry) => entry.index),
    [1, 2, 3],
  );
});

test("prefetch does not start more downloads after reaching the byte budget", () => {
  const prefetcher = new HlsSegmentPrefetcher({ maxBytes: 4, maxConcurrent: 1 });
  prefetcher.prefetches.set(segment(1).url, cachedEntry("full"));
  prefetcher.prefetches.set(segment(2).url, {
    url: segment(2).url,
    index: 2,
    state: "queued",
    promise: null,
    controller: null,
  });

  prefetcher.pumpPrefetches();

  assert.equal(prefetcher.prefetches.get(segment(2).url).state, "queued");
  const stats = prefetcher.getStats();
  assert.equal(stats.cachedBytes, 4);
  assert.equal(stats.cachedSegments, 1);
  assert.equal(stats.maxBytes, 4);
  assert.equal(stats.cacheUtilization, 1);
  assert.equal(stats.byteCapHitCount, 1);
});

test("prefetch reserves estimated bytes before starting another download", () => {
  const prefetcher = new HlsSegmentPrefetcher({ maxBytes: 10, maxConcurrent: 1 });
  prefetcher.segmentSizeSamples = [4];
  prefetcher.prefetches.set(segment(1).url, { ...cachedEntry("12345678"), index: 1 });
  prefetcher.prefetches.set(segment(2).url, {
    url: segment(2).url,
    index: 2,
    state: "queued",
    promise: null,
    controller: null,
  });

  prefetcher.pumpPrefetches();

  assert.equal(prefetcher.prefetches.get(segment(2).url).state, "queued");
  assert.equal(prefetcher.byteCapHitCount, 1);
  assert.equal(prefetcher.getStats().managedBytesEstimate, 8);
  prefetcher.pumpPrefetches();
  assert.equal(prefetcher.byteCapHitCount, 1);
});

test("ready cache trims the farthest segments to stay within its byte budget", () => {
  const prefetcher = new HlsSegmentPrefetcher({ maxBytes: 6, maxConcurrent: 1 });
  const near = { ...cachedEntry("near"), index: 1 };
  const far = { ...cachedEntry("far!"), index: 2 };
  prefetcher.prefetches.set(segment(1).url, near);
  prefetcher.prefetches.set(segment(2).url, far);

  prefetcher.updateCachePeaks();
  prefetcher.trimReadyCacheToBudget();

  assert.equal(prefetcher.prefetches.has(segment(1).url), true);
  assert.equal(prefetcher.prefetches.has(segment(2).url), false);
  assert.equal(prefetcher.cachedBytes, 4);
  assert.equal(prefetcher.peakCachedBytes, 8);
  assert.equal(prefetcher.byteCapHitCount, 1);
});
