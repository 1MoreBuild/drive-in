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

function playlistBody(segments) {
  return `#EXTM3U\n${segments.map((item) => `#EXTINF:${item.duration},\n${item.url}`).join("\n")}\n`;
}

test("buffer health stops at the first missing segment", () => {
  const prefetcher = new HlsSegmentPrefetcher();
  const segments = [segment(0), segment(1), segment(2), segment(3)];
  const playlistUrl = "https://drivein.test/video.m3u8";
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;
  prefetcher.prefetches.set(segment(1).url, { state: "pending" });
  prefetcher.prefetches.set(segment(2).url, cachedEntry("two"));
  prefetcher.prefetches.set(segment(3).url, cachedEntry("three"));

  const stats = prefetcher.getStats();
  assert.equal(stats.bufferedAheadSeconds, 0);
  assert.equal(stats.readySegments, 0);
  assert.equal(stats.pendingSegments, 1);
});

test("recognizes extensionless proxied live segments after EXTINF", () => {
  const prefetcher = new HlsSegmentPrefetcher({ maxConcurrent: 0 });
  const masterUrl = "https://drivein.test/api/proxy/hls?id=master";
  prefetcher.updatePlaylist(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\n/api/proxy/hls?id=variant\n",
    masterUrl,
  );
  assert.equal(prefetcher.playlists.size, 0);

  const mediaUrl = "https://drivein.test/api/proxy/hls?id=variant";
  prefetcher.updatePlaylist(
    "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.0,\n/api/proxy?id=segment-100\n#EXTINF:5.0,\n/api/proxy?id=segment-101\n",
    mediaUrl,
  );

  const playlist = prefetcher.playlists.get(mediaUrl);
  assert.deepEqual(playlist.segments, [
    { url: "https://drivein.test/api/proxy?id=segment-100", duration: 5 },
    { url: "https://drivein.test/api/proxy?id=segment-101", duration: 5 },
  ]);
  assert.equal(prefetcher.segmentIndexes.size, 2);
});

test("reports an absolute DVR timeline without caching the full history", () => {
  const prefetcher = new HlsSegmentPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://drivein.test/api/proxy/hls?id=live";
  prefetcher.updatePlaylist(
    "#EXTM3U\n#EXT-X-DRIVE-IN-DVR-START:1000\n#EXT-X-DRIVE-IN-LIVE-EDGE:4600\n#EXTINF:2,\n/api/proxy/live-segment?id=live&sq=100\n",
    playlistUrl,
  );
  const playlist = prefetcher.playlists.get(playlistUrl);
  prefetcher.advancePlaylist(playlist, 0, playlist.segments[0].url);

  const stats = prefetcher.getStats();
  assert.equal(stats.liveDvrStartTime, 1000);
  assert.ok(stats.liveEdgeTime >= 4600);
  assert.equal(playlist.segments.length, 1);
});

test("parses a proxied live playlist URL without an m3u8 suffix", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(
    "#EXTM3U\n#EXTINF:2.0,\n/api/proxy?id=segment-200\n",
    { headers: { "content-type": "application/vnd.apple.mpegurl" } },
  );
  const prefetcher = new HlsSegmentPrefetcher({ maxConcurrent: 0 });

  await prefetcher.fetch("https://drivein.test/api/proxy/hls?id=variant");

  assert.equal(prefetcher.playlists.size, 1);
  assert.deepEqual(
    [...prefetcher.segmentIndexes.keys()],
    ["https://drivein.test/api/proxy?id=segment-200"],
  );
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
  const playlistUrl = "https://drivein.test/video.m3u8";
  prefetcher.updatePlaylist(playlistBody([segment(20), segment(21)]), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;
  prefetcher.playlists.get(playlistUrl).currentUrl = segment(20).url;
  prefetcher.prefetches.set(segment(21).url, { state: "queued", controller: null });

  prefetcher.handleSeek();

  assert.equal(prefetcher.playlists.get(playlistUrl).currentIndex, -1);
  assert.equal(prefetcher.playlists.get(playlistUrl).currentUrl, null);
  assert.equal(prefetcher.prefetches.size, 0);
});

test("prefetch defaults target a 180-second in-car buffer", () => {
  const prefetcher = new HlsSegmentPrefetcher();
  assert.equal(prefetcher.targetAheadSeconds, 180);
  assert.equal(prefetcher.ahead, 90);
  assert.equal(prefetcher.maxBytes, 96 * 1024 * 1024);
  assert.equal(prefetcher.maxConcurrent, 1);
});

test("prefetch scheduling stops after reaching the time target", () => {
  const prefetcher = new HlsSegmentPrefetcher({
    ahead: 36,
    targetAheadSeconds: 12,
    maxConcurrent: 0,
  });
  const playlistUrl = "https://drivein.test/video.m3u8";
  prefetcher.updatePlaylist(
    playlistBody(Array.from({ length: 10 }, (_, index) => segment(index, 4))),
    playlistUrl,
  );

  prefetcher.scheduleAhead(playlistUrl, 1);

  assert.deepEqual(
    [...prefetcher.prefetches.values()].map((entry) => entry.index),
    [1, 2, 3],
  );
});

test("keeps separate audio and video playlists buffered", () => {
  const prefetcher = new HlsSegmentPrefetcher({ maxConcurrent: 0 });
  const videoUrl = "https://drivein.test/video.m3u8";
  const audioUrl = "https://drivein.test/audio.m3u8";
  const videoSegments = Array.from({ length: 4 }, (_, index) => ({
    url: `https://drivein.test/video-${index}.m4s`,
    duration: 5,
  }));
  const audioSegments = Array.from({ length: 4 }, (_, index) => ({
    url: `https://drivein.test/audio-${index}.m4s`,
    duration: 5,
  }));

  prefetcher.updatePlaylist(playlistBody(videoSegments), videoUrl);
  prefetcher.updatePlaylist(playlistBody(audioSegments), audioUrl);
  prefetcher.playlists.get(videoUrl).currentIndex = 0;
  prefetcher.playlists.get(audioUrl).currentIndex = 0;
  prefetcher.scheduleAhead(videoUrl, 1);
  prefetcher.scheduleAhead(audioUrl, 1);

  assert.deepEqual(prefetcher.segmentIndexes.get(videoSegments[1].url), {
    playlistUrl: videoUrl,
    index: 1,
  });
  assert.deepEqual(prefetcher.segmentIndexes.get(audioSegments[1].url), {
    playlistUrl: audioUrl,
    index: 1,
  });
  assert.equal(prefetcher.prefetches.size, 6);

  for (const item of videoSegments.slice(1, 3)) {
    prefetcher.prefetches.set(item.url, { ...cachedEntry(item.url), playlistUrl: videoUrl });
  }
  prefetcher.prefetches.set(audioSegments[1].url, {
    ...cachedEntry(audioSegments[1].url),
    playlistUrl: audioUrl,
  });

  const stats = prefetcher.getStats();
  assert.equal(stats.activePlaylistCount, 2);
  assert.equal(stats.bufferedAheadSeconds, 5);
  assert.equal(stats.readySegments, 3);
  assert.deepEqual(
    stats.playlistStats.map((item) => item.bufferedAheadSeconds),
    [10, 5],
  );
});

test("jumping to a resume position drops stale startup prefetches", () => {
  const prefetcher = new HlsSegmentPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://drivein.test/video.m3u8";
  const segments = Array.from({ length: 10 }, (_, index) => segment(index));
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  const playlist = prefetcher.playlists.get(playlistUrl);
  prefetcher.advancePlaylist(playlist, 0, segments[0].url);
  prefetcher.scheduleAhead(playlistUrl, 1);

  prefetcher.advancePlaylist(playlist, 7, segments[7].url);

  assert.equal(playlist.currentIndex, 7);
  assert.deepEqual(
    [...prefetcher.prefetches.values()].map((entry) => entry.index),
    [7, 8, 9],
  );
  assert.equal(prefetcher.advancePlaylist(playlist, 1, segments[1].url), false);
  assert.equal(playlist.currentIndex, 7);
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
