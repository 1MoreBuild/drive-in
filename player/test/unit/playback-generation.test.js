import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackGeneration } from "../../src/playback-generation.js";

test("latest playback generation wins", () => {
  const generation = new PlaybackGeneration();
  const first = generation.begin();
  const second = generation.begin();
  assert.equal(generation.isCurrent(first), false);
  assert.equal(generation.isCurrent(second), true);
});

test("stop invalidates the active player generation", () => {
  const generation = new PlaybackGeneration();
  const active = generation.begin();
  generation.cancel();
  assert.equal(generation.isCurrent(active), false);
});
