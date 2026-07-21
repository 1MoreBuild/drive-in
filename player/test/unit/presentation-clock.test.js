import assert from "node:assert/strict";
import test from "node:test";

import { estimateAudioOutputLatencySeconds } from "../../src/engine/presentation-clock.js";

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
