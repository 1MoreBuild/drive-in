import assert from "node:assert/strict";
import test from "node:test";

import {
  cachedEntry,
  createPrefetcher,
  playlistBody,
  segment,
  TEST_ORIGIN,
} from "../helpers/hls-fixture.js";

test("buffer health stops at the first missing segment", () => {
  const prefetcher = createPrefetcher();
  const segments = [segment(0), segment(1), segment(2), segment(3)];
  const playlistUrl = "https://drivein.test/video.m3u8";
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.playlists.get(playlistUrl).currentIndex = 0;
  prefetcher.jobs.set(segment(1).url, { state: "pending" });
  prefetcher.segmentCache.set(segment(2).url, cachedEntry("two"));
  prefetcher.segmentCache.set(segment(3).url, cachedEntry("three"));

  const stats = prefetcher.getStats();
  assert.equal(stats.bufferedAheadSeconds, 0);
  assert.equal(stats.readySegments, 0);
  assert.equal(stats.pendingSegments, 1);
});

test("recognizes extensionless proxied live segments after EXTINF", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
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
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
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

test("parses a proxied live playlist URL without an m3u8 suffix", async () => {
  const prefetcher = createPrefetcher({
    maxConcurrent: 0,
    fetchImpl: async () => new Response(
      "#EXTM3U\n#EXTINF:2.0,\n/api/proxy?id=segment-200\n",
      { headers: { "content-type": "application/vnd.apple.mpegurl" } },
    ),
  });

  await prefetcher.fetch("https://drivein.test/api/proxy/hls?id=variant");

  assert.equal(prefetcher.playlists.size, 1);
  assert.deepEqual(
    [...prefetcher.segmentIndexes.keys()],
    ["https://drivein.test/api/proxy?id=segment-200"],
  );
});

test("playlist replacement preserves already downloaded segments", async () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const oldUrl = segment("old").url;
  prefetcher.updatePlaylist(`#EXTM3U\n#EXTINF:5,\n${oldUrl}\n`, TEST_ORIGIN);
  prefetcher.segmentCache.set(oldUrl, cachedEntry("old rendition"));

  prefetcher.updatePlaylist("#EXTM3U\n#EXTINF:5,\n/new.m4s\n", TEST_ORIGIN);

  assert.equal(prefetcher.segmentIndexes.has(oldUrl), false);
  assert.equal(prefetcher.segmentCache.has(oldUrl), true);
  const response = await prefetcher.fetch(oldUrl);
  assert.equal(await response.text(), "old rendition");
});

test("seek preserves completed media and recenters pending work", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://drivein.test/video.m3u8";
  const segments = Array.from({ length: 8 }, (_, index) => segment(index, 5));
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  const playlist = prefetcher.playlists.get(playlistUrl);
  playlist.currentIndex = 6;
  playlist.currentUrl = segments[6].url;
  prefetcher.segmentCache.set(segments[1].url, {
    ...cachedEntry("played"),
    url: segments[1].url,
    playlistUrl,
    index: 1,
  });
  const obsoleteJob = {
    url: segments[7].url,
    playlistUrl,
    index: 7,
    state: "queued",
    controller: null,
  };
  prefetcher.jobs.set(segments[7].url, obsoleteJob);

  prefetcher.handleSeek(7);

  assert.equal(playlist.currentIndex, 0);
  assert.equal(playlist.currentUrl, segments[0].url);
  assert.equal(prefetcher.segmentCache.has(segments[1].url), true);
  assert.notEqual(prefetcher.jobs.get(segments[7].url), obsoleteJob);
  assert.deepEqual(
    [...prefetcher.jobs.values()].map((entry) => entry.index),
    [2, 3, 4, 5, 6, 7],
  );
  assert.equal(prefetcher.getStats().activePlaylistCount, 1);
});

test("live seek maps absolute time from the first program timestamp", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://drivein.test/live.m3u8";
  prefetcher.updatePlaylist([
    "#EXTM3U",
    "#EXT-X-PROGRAM-DATE-TIME:2026-07-21T00:00:00.000Z",
    "#EXTINF:5,",
    "0.m4s",
    "#EXT-X-PROGRAM-DATE-TIME:2026-07-21T00:00:05.000Z",
    "#EXTINF:5,",
    "1.m4s",
    "#EXT-X-PROGRAM-DATE-TIME:2026-07-21T00:00:10.000Z",
    "#EXTINF:5,",
    "2.m4s",
  ].join("\n"), playlistUrl);
  const playlist = prefetcher.playlists.get(playlistUrl);

  assert.equal(playlist.playlistStartTime, Date.parse("2026-07-21T00:00:00.000Z") / 1000);
  assert.equal(prefetcher.segmentIndexAtTime(
    playlist,
    Date.parse("2026-07-21T00:00:07.000Z") / 1000,
  ), 1);
});

test("a consumed segment remains reusable for backward playback", async () => {
  let networkRequests = 0;
  const prefetcher = createPrefetcher({
    maxConcurrent: 0,
    fetchImpl: async () => {
      networkRequests += 1;
      return new Response("network");
    },
  });
  const playlistUrl = "https://drivein.test/video.m3u8";
  const segments = [segment(0), segment(1), segment(2)];
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  prefetcher.segmentCache.set(segments[1].url, {
    ...cachedEntry("cached once"),
    url: segments[1].url,
    playlistUrl,
    index: 1,
  });

  assert.equal(await (await prefetcher.fetch(segments[1].url)).text(), "cached once");
  assert.equal(await (await prefetcher.fetch(segments[1].url)).text(), "cached once");
  assert.equal(networkRequests, 0);
  assert.equal(prefetcher.segmentCache.has(segments[1].url), true);
});

test("prefetch defaults target a 180-second in-car buffer", () => {
  const prefetcher = createPrefetcher();
  assert.equal(prefetcher.targetAheadSeconds, 180);
  assert.equal(prefetcher.ahead, 90);
  assert.equal(prefetcher.maxBytes, 96 * 1024 * 1024);
  assert.equal(prefetcher.maxConcurrent, 1);
});

test("prefetch scheduling stops after reaching the time target", () => {
  const prefetcher = createPrefetcher({
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
    [...prefetcher.jobs.values()].map((entry) => entry.index),
    [1, 2, 3],
  );
});

test("keeps separate audio and video playlists buffered", () => {
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
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
  assert.equal(prefetcher.jobs.size, 6);

  for (const item of videoSegments.slice(1, 3)) {
    prefetcher.segmentCache.set(item.url, {
      ...cachedEntry(item.url),
      url: item.url,
      playlistUrl: videoUrl,
      index: videoSegments.indexOf(item),
    });
    prefetcher.jobs.delete(item.url);
  }
  prefetcher.segmentCache.set(audioSegments[1].url, {
    ...cachedEntry(audioSegments[1].url),
    url: audioSegments[1].url,
    playlistUrl: audioUrl,
    index: 1,
  });
  prefetcher.jobs.delete(audioSegments[1].url);

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
  const prefetcher = createPrefetcher({ maxConcurrent: 0 });
  const playlistUrl = "https://drivein.test/video.m3u8";
  const segments = Array.from({ length: 10 }, (_, index) => segment(index));
  prefetcher.updatePlaylist(playlistBody(segments), playlistUrl);
  const playlist = prefetcher.playlists.get(playlistUrl);
  prefetcher.advancePlaylist(playlist, 0, segments[0].url);
  prefetcher.scheduleAhead(playlistUrl, 1);

  prefetcher.advancePlaylist(playlist, 7, segments[7].url);

  assert.equal(playlist.currentIndex, 7);
  assert.deepEqual(
    [...prefetcher.jobs.values()].map((entry) => entry.index),
    [7, 8, 9],
  );
  assert.equal(prefetcher.advancePlaylist(playlist, 1, segments[1].url), false);
  assert.equal(playlist.currentIndex, 7);
});

test("cache pressure evicts history instead of starving forward work", () => {
  const prefetcher = createPrefetcher({ maxBytes: 4, maxConcurrent: 0 });
  prefetcher.segmentCache.set(segment(1).url, cachedEntry("full"));
  prefetcher.jobs.set(segment(2).url, {
    url: segment(2).url,
    index: 2,
    state: "queued",
    promise: null,
    controller: null,
  });

  prefetcher.pumpPrefetches();

  assert.equal(prefetcher.jobs.get(segment(2).url).state, "queued");
  const stats = prefetcher.getStats();
  assert.equal(stats.cachedBytes, 0);
  assert.equal(stats.cachedSegments, 0);
  assert.equal(stats.maxBytes, 4);
  assert.equal(stats.cacheUtilization, 0);
  assert.equal(stats.byteCapHitCount, 1);
});

test("prefetch makes room for estimated bytes before starting a download", () => {
  const prefetcher = createPrefetcher({ maxBytes: 10, maxConcurrent: 1 });
  prefetcher.segmentSizeSamples = [4];
  prefetcher.segmentCache.set(segment(1).url, { ...cachedEntry("12345678"), index: 1 });
  prefetcher.jobs.set(segment(2).url, {
    url: segment(2).url,
    index: 2,
    state: "queued",
    promise: null,
    controller: null,
  });
  prefetcher.startPrefetchEntry = (entry) => {
    entry.state = "pending";
    return null;
  };

  prefetcher.pumpPrefetches();

  assert.equal(prefetcher.jobs.get(segment(2).url).state, "pending");
  assert.equal(prefetcher.byteCapHitCount, 1);
  assert.equal(prefetcher.getStats().managedBytesEstimate, 4);
  prefetcher.pumpPrefetches();
  assert.equal(prefetcher.byteCapHitCount, 1);
});

test("ready cache trims the farthest segments to stay within its byte budget", () => {
  const prefetcher = createPrefetcher({ maxBytes: 6, maxConcurrent: 1 });
  const near = { ...cachedEntry("near"), index: 1 };
  const far = { ...cachedEntry("far!"), index: 2 };
  prefetcher.segmentCache.set(segment(1).url, near);
  prefetcher.segmentCache.set(segment(2).url, far);

  prefetcher.updateCachePeaks();
  prefetcher.trimReadyCacheToBudget();

  assert.equal(prefetcher.segmentCache.has(segment(1).url), true);
  assert.equal(prefetcher.segmentCache.has(segment(2).url), false);
  assert.equal(prefetcher.cachedBytes, 4);
  assert.equal(prefetcher.peakCachedBytes, 8);
  assert.equal(prefetcher.byteCapHitCount, 1);
});
