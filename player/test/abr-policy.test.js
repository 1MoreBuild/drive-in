import test from "node:test";
import assert from "node:assert/strict";
import { MediabunnyPlayer } from "../src/engine/mediabunny-player.js";

test("rebuffer during ABR cooldown remains pending until a downshift can run", async () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  player.abr = { bitrates: [3000, 5000], currentBitrate: 5000 };
  player.hlsSegmentPrefetcher = {
    getStats: () => ({ sampleCount: 0, bufferedAheadSeconds: 0, throughputKbps: 0 }),
  };
  player.abrSwitching = false;
  player.destroyed = false;
  player.lastAbrEvaluationAt = 0;
  player.lastAbrSwitchAt = 0;
  player.lastAbrAttemptAt = 0;
  player.abrStartedAt = 0;
  player.lastAbrRiskAt = 0;
  player.lastAbrRebufferAt = 0;
  player.lastAbrVideoStutterCount = 0;
  player.videoStutterCount = 1;
  player.pendingAbrRebufferRisk = false;
  player.persistAbrEstimate = () => {};
  const switches = [];
  player.switchAbrBitrate = async (bitrate, reason) => {
    switches.push({ bitrate, reason });
    return true;
  };

  await player.evaluateAbr(5_000);
  assert.equal(player.pendingAbrRebufferRisk, true);
  assert.deepEqual(switches, []);

  await player.evaluateAbr(9_000);
  assert.deepEqual(switches, [{ bitrate: 3000, reason: "rebuffer-risk" }]);
  assert.equal(player.pendingAbrRebufferRisk, false);
});

test("HLS playback waits for a 15-second encoded startup buffer", () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  player.duration = 120;
  player.hasDecodedStartupBuffer = () => true;
  let bufferedAheadSeconds = 10;
  player.hlsSegmentPrefetcher = {
    getStats: () => ({
      activePlaylistCount: 2,
      bufferedAheadSeconds,
      pendingSegments: 20,
    }),
  };

  assert.equal(player.hasStartupBuffer(30), false);
  bufferedAheadSeconds = 15;
  assert.equal(player.hasStartupBuffer(30), true);
});

test("HLS startup buffer shrinks at the end of a video", () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  player.duration = 120;
  player.hasDecodedStartupBuffer = () => true;
  player.hlsSegmentPrefetcher = {
    getStats: () => ({
      activePlaylistCount: 2,
      bufferedAheadSeconds: 4,
      pendingSegments: 2,
    }),
  };

  assert.equal(player.hasStartupBuffer(116), true);
});

test("low-latency live playback starts with two encoded seconds", () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  player.duration = 0;
  player.isLive = true;
  player.hlsStartSeconds = 2;
  player.hasDecodedStartupBuffer = () => true;
  let bufferedAheadSeconds = 1;
  player.hlsSegmentPrefetcher = {
    getStats: () => ({
      activePlaylistCount: 2,
      bufferedAheadSeconds,
      pendingSegments: 2,
    }),
  };

  assert.equal(player.hasStartupBuffer(0), false);
  bufferedAheadSeconds = 2;
  assert.equal(player.hasStartupBuffer(0), true);
});

test("live-edge seek preserves the encoded HLS buffer", async () => {
  const player = Object.create(MediabunnyPlayer.prototype);
  player.firstTimestamp = 0;
  player.duration = 120;
  player.wantsPlayback = false;
  player.audioRing = { setRunning: () => {} };
  player.clock = { stop: () => {} };
  player.setState = () => {};
  player.restartProducers = async () => {};
  let resetCount = 0;
  player.hlsSegmentPrefetcher = { handleSeek: () => { resetCount += 1; } };

  await player.seek(1_000, { preserveHlsBuffer: true });
  assert.equal(resetCount, 0);
  await player.seek(2_000);
  assert.equal(resetCount, 1);
});
