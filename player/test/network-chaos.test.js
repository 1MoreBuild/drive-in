import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFreshPlaybackSessionRequest,
  playbackRecoveryDelayMs,
} from "../src/playback-recovery.js";

function firstRecoveryAfter(outageMs) {
  let elapsedMs = 0;
  let attempt = 0;
  while (elapsedMs < outageMs) {
    attempt += 1;
    elapsedMs += playbackRecoveryDelayMs(attempt);
  }
  return { attempt, elapsedMs, recoveryLagMs: elapsedMs - outageMs };
}

for (const outageSeconds of [30, 60, 180]) {
  test(`recovery keeps retrying through a ${outageSeconds}-second disconnect`, () => {
    const result = firstRecoveryAfter(outageSeconds * 1000);
    assert.ok(result.attempt > 0);
    assert.ok(result.recoveryLagMs >= 0);
    assert.ok(result.recoveryLagMs <= 60_000, "capped backoff must retry within one minute of reconnection");
  });
}

test("network switching re-resolves the original source instead of a stale CDN URL", () => {
  const request = buildFreshPlaybackSessionRequest({
    url: "/api/dash/hls/expired/master.m3u8",
    meta: { sourceUrl: "https://www.youtube.com/watch?v=source-id" },
  }, 42.5);
  assert.equal(request.endpoint, "/api/play");
  assert.equal(request.body.url, "https://www.youtube.com/watch?v=source-id");
  assert.equal(request.body.startTime, 42.5);
  assert.equal(request.body.reason, "recovery");
});

test("server restart recovery creates a fresh Plex session with track choices and position", () => {
  const request = buildFreshPlaybackSessionRequest({
    url: "/api/plex/hls/master.m3u8",
    meta: {
      plex: {
        ratingKey: "99",
        activeSubtitleID: "12",
        activeAudioID: "7",
      },
    },
  }, 91.25);
  assert.deepEqual(request, {
    endpoint: "/api/plex/play",
    body: {
      ratingKey: "99",
      subtitleStreamID: "12",
      audioStreamID: "7",
      offset: 91_250,
      recovery: true,
    },
  });
});

test("recovery backoff remains capped during a prolonged outage", () => {
  assert.equal(playbackRecoveryDelayMs(1), 1_000);
  assert.equal(playbackRecoveryDelayMs(5), 60_000);
  assert.equal(playbackRecoveryDelayMs(50), 60_000);
});
