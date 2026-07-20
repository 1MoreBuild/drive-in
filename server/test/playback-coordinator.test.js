import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlaybackSuperseded,
  PlaybackCoordinator,
} from "../playback-coordinator.js";

test("a newer playback request invalidates and aborts the older request", () => {
  const coordinator = new PlaybackCoordinator();
  const first = coordinator.begin("first");
  const second = coordinator.begin("second");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.throws(() => first.assertCurrent(), isPlaybackSuperseded);
  assert.doesNotThrow(() => second.assertCurrent());
});

test("stop invalidates the active playback request", () => {
  const coordinator = new PlaybackCoordinator();
  const request = coordinator.begin();
  coordinator.cancel();
  assert.equal(request.signal.aborted, true);
  assert.throws(() => request.assertCurrent(), isPlaybackSuperseded);
});
