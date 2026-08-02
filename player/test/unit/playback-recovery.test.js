import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFreshPlaybackSessionRequest,
  hasRecoveryPlaybackProgress,
  hasSeekPlaybackProgress,
  playbackRecoveryDelayMs,
  resolvePlaybackPosition,
  shouldHoldOptimisticSeekTarget,
  shouldRestartPlexSessionForSeek,
} from "../../src/playback-recovery.js";

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
      autoplay: true,
    },
  });
});

test("recovery preserves a paused user intent", () => {
  const request = buildFreshPlaybackSessionRequest({
    meta: { sourceUrl: "https://www.youtube.com/watch?v=source-id" },
  }, 12, { autoplay: false });
  assert.equal(request.body.autoplay, false);
});

test("user-directed Plex seek creates a normal latest-wins playback request", () => {
  const request = buildFreshPlaybackSessionRequest({
    meta: {
      plex: {
        ratingKey: "99",
        activeSubtitleID: "12",
        activeAudioID: "7",
      },
    },
  }, 420, {
    autoplay: false,
    recovery: false,
    reason: "seek",
  });
  assert.deepEqual(request, {
    endpoint: "/api/plex/play",
    body: {
      ratingKey: "99",
      subtitleStreamID: "12",
      audioStreamID: "7",
      offset: 420_000,
      recovery: false,
      autoplay: false,
      reason: "seek",
    },
  });
});

test("Plex seek restarts the session before the resumed HLS timeline", () => {
  assert.equal(shouldRestartPlexSessionForSeek({
    plexRatingKey: "99",
    targetTime: 7 * 60,
    seekableStartTime: 11_622,
  }), true);
});

test("Plex seek stays local inside the current HLS timeline", () => {
  assert.equal(shouldRestartPlexSessionForSeek({
    plexRatingKey: "99",
    targetTime: 11_700,
    seekableStartTime: 11_622,
  }), false);
  assert.equal(shouldRestartPlexSessionForSeek({
    plexRatingKey: null,
    targetTime: 420,
    seekableStartTime: 11_622,
  }), false);
});

test("a pending Plex session restart keeps later seeks latest-wins", () => {
  assert.equal(shouldRestartPlexSessionForSeek({
    plexRatingKey: "99",
    targetTime: 11_700,
    seekableStartTime: 11_622,
    sessionRestartPending: true,
  }), true);
});

test("optimistic seek holds the target only for the current transition player", () => {
  assert.equal(shouldHoldOptimisticSeekTarget({
    transitionPending: true,
    playerIsCurrent: true,
  }), true);
  assert.equal(shouldHoldOptimisticSeekTarget({
    transitionPending: false,
    playerIsCurrent: true,
  }), false);
  assert.equal(shouldHoldOptimisticSeekTarget({
    transitionPending: true,
    playerIsCurrent: false,
  }), false);
});

test("recovery is confirmed only by advancing presentation time", () => {
  assert.equal(hasRecoveryPlaybackProgress({
    status: "buffering",
    baselineTime: 10,
    currentTime: 20,
  }), false);
  assert.equal(hasRecoveryPlaybackProgress({
    status: "playing",
    baselineTime: 10,
    currentTime: 10.1,
  }), false);
  assert.equal(hasRecoveryPlaybackProgress({
    status: "playing",
    baselineTime: 10,
    currentTime: 10.3,
  }), true);
  assert.equal(hasRecoveryPlaybackProgress({
    status: "playing",
    baselineTime: 10,
    currentTime: 20,
    hasVideo: true,
    videoFrameRenderCount: 0,
  }), false);
  assert.equal(hasRecoveryPlaybackProgress({
    status: "playing",
    baselineTime: 10,
    currentTime: 10.3,
    hasVideo: true,
    videoFrameRenderCount: 1,
  }), true);
});

test("recovery backoff remains capped during a prolonged outage", () => {
  assert.equal(playbackRecoveryDelayMs(1), 1_000);
  assert.equal(playbackRecoveryDelayMs(5), 60_000);
  assert.equal(playbackRecoveryDelayMs(50), 60_000);
});

test("the engine presentation clock wins over a stale UI snapshot", () => {
  assert.equal(resolvePlaybackPosition({
    engineTime: 397.6,
    fallbackTime: 303,
    duration: 815,
  }), 397.6);
  assert.equal(resolvePlaybackPosition({
    engineTime: Number.NaN,
    fallbackTime: 303,
    duration: 815,
  }), 303);
});

test("seek watchdog requires presentation progress beyond the target", () => {
  const before = {
    videoFrameDecodeCount: 100,
    audioFrameRenderCount: 200,
    videoCurrentTimeMs: 10_000,
    audioCurrentTimeMs: 10_000,
  };
  assert.equal(hasSeekPlaybackProgress(before, {
    ...before,
    videoFrameDecodeCount: 101,
  }, 10, 250), false);
  assert.equal(hasSeekPlaybackProgress(before, {
    ...before,
    audioFrameRenderCount: 201,
  }, 10, 250), false);
  assert.equal(hasSeekPlaybackProgress(before, {
    ...before,
    videoCurrentTimeMs: 10_300,
    audioCurrentTimeMs: 10_300,
  }, 10, 250), true);
});

test("seek watchdog rejects a fake buffering state with no producer progress", () => {
  const snapshot = {
    videoFrameDecodeCount: 100,
    audioFrameRenderCount: 200,
    videoCurrentTimeMs: 10_000,
    audioCurrentTimeMs: 10_000,
  };
  assert.equal(hasSeekPlaybackProgress(snapshot, { ...snapshot }, 10), false);
});
