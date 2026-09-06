import assert from "node:assert/strict";
import test from "node:test";

import { estimateAudioOutputLatencySeconds, PresentationClock } from "../../src/engine/presentation-clock.js";

test("estimates the audible output delay from an output timestamp", () => {
  const audioContext = {
    currentTime: 10.12,
    getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 1_000 }),
  };

  assert.ok(Math.abs(estimateAudioOutputLatencySeconds(audioContext, 1_020) - 0.1) < 1e-9);
});

test("falls back to the reported base and device output latency", () => {
  const audioContext = {
    currentTime: 10,
    baseLatency: 0.01,
    outputLatency: 0.08,
  };

  assert.equal(estimateAudioOutputLatencySeconds(audioContext, 1_000), 0.09);
});

test("caps an implausible output latency estimate", () => {
  const audioContext = {
    currentTime: 12,
    getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 1_000 }),
  };

  assert.equal(estimateAudioOutputLatencySeconds(audioContext, 1_000), 0.5);
});

test("an exhausted audio clock hands off continuously and supports pause and seek", (t) => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const clock = new PresentationClock();
  const ring = { consumedFrames: 96_000 };
  clock.useAudioRing(ring, 48_000);
  clock.reset(10);
  clock.start();
  assert.equal(clock.currentTime, 12);
  clock.useWallClock();
  assert.equal(clock.currentTime, 12);
  now += 500;
  assert.equal(clock.currentTime, 12.5);
  clock.useWallClock(); // The render loop may call this on every frame.
  clock.stop();
  now += 2_000;
  assert.equal(clock.currentTime, 12.5);
  clock.start();
  now += 500;
  assert.equal(clock.currentTime, 13);
  clock.stop();
  ring.consumedFrames = 0;
  clock.useAudioRing(ring, 48_000);
  clock.reset(1);
  clock.start();
  ring.consumedFrames = 24_000;
  assert.equal(clock.currentTime, 1.5);
});
