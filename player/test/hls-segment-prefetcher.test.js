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

test("prefetch throughput uses one controlled download at a time", () => {
  const prefetcher = new HlsSegmentPrefetcher();
  assert.equal(prefetcher.maxConcurrent, 1);
});
