import assert from "node:assert/strict";
import test from "node:test";

import { hasHlsStartupBuffer } from "../../src/engine/playback-buffer-policy.js";
import { HlsSegmentPrefetcher } from "../../src/engine/hls-segment-prefetcher.js";

const registeredPlaylist = (bufferedAheadSeconds, pendingSegments = 1) => ({
  activePlaylistCount: 2,
  bufferedAheadSeconds,
  pendingSegments,
});

test("startup requires decoded media before considering network runway", () => {
  assert.equal(hasHlsStartupBuffer({
    decodedReady: false,
    network: registeredPlaylist(60),
  }), false);
});

test("on-demand playback requires fifteen seconds of encoded runway", () => {
  assert.equal(hasHlsStartupBuffer({
    decodedReady: true,
    network: registeredPlaylist(14.9),
    mediaTime: 30,
    duration: 120,
  }), false);
  assert.equal(hasHlsStartupBuffer({
    decodedReady: true,
    network: registeredPlaylist(15),
    mediaTime: 30,
    duration: 120,
  }), true);
});

test("startup runway is bounded by media remaining near the end", () => {
  assert.equal(hasHlsStartupBuffer({
    decodedReady: true,
    network: registeredPlaylist(4),
    mediaTime: 116,
    duration: 120,
  }), true);
});

test("decoded media breaks an empty playlist registration cycle only when no work exists", () => {
  const idleNetwork = {
    activePlaylistCount: 0,
    pendingSegments: 0,
    activeDownloads: 0,
    queuedSegments: 0,
    retryWaitingSegments: 0,
  };
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network: idleNetwork }), true);
  assert.equal(hasHlsStartupBuffer({
    decodedReady: true,
    network: { ...idleNetwork, queuedSegments: 1 },
  }), false);
});

test("low-latency live playback honors its explicit two-second target", () => {
  assert.equal(hasHlsStartupBuffer({
    decodedReady: true,
    network: registeredPlaylist(1),
    requiredStartSeconds: 2,
  }), false);
  assert.equal(hasHlsStartupBuffer({
    decodedReady: true,
    network: registeredPlaylist(2),
    requiredStartSeconds: 2,
  }), true);
});

test("a fully downloaded ENDLIST tail can start without a future segment", async (t) => {
  const prefetcher = new HlsSegmentPrefetcher({ fetchImpl: async () => new Response("media") });
  t.after(() => prefetcher.destroy());
  const manifest = '#EXTM3U\n#EXTINF:4,\nseg0.m4s\n';
  prefetcher.updatePlaylist(manifest, "https://fixture.test/short.m3u8");
  await prefetcher.fetch("https://fixture.test/seg0.m4s");
  assert.equal(prefetcher.getStats().allRemainingSegmentsCached, false);
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network: prefetcher.getStats(), duration: 4 }), false);
  // An unchanged segment list can become finite on the final playlist update.
  prefetcher.updatePlaylist(`${manifest}#EXT-X-ENDLIST\n`, "https://fixture.test/short.m3u8");
  const network = prefetcher.getStats();
  assert.equal(network.bufferedAheadSeconds, 0);
  assert.equal(network.allRemainingSegmentsCached, true);
  assert.equal(hasHlsStartupBuffer({ decodedReady: true, network, duration: 4 }), true);
  assert.equal(hasHlsStartupBuffer({ decodedReady: false, network, duration: 4 }), false);
});
