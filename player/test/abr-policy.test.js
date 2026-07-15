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
