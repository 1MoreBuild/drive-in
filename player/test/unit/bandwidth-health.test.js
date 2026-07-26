import assert from "node:assert/strict";
import test from "node:test";
import { assessBandwidthHealth } from "../../src/bandwidth-health.js";

const profile = { height: 720, fps: 60, videoKbps: 2200, audioKbps: 128 };

test("waits for sustained buffering and multiple throughput samples", () => {
  assert.equal(assessBandwidthHealth({
    bufferingMs: 7_999,
    streamProfile: profile,
    stats: { bandwidth: 500_000, hlsThroughputSampleCount: 3 },
  }), null);
  assert.equal(assessBandwidthHealth({
    bufferingMs: 9_000,
    streamProfile: profile,
    stats: { bandwidth: 500_000, hlsThroughputSampleCount: 1 },
  }), null);
});

test("explains a measured slowdown without exposing playback policy", () => {
  const result = assessBandwidthHealth({
    bufferingMs: 9_000,
    streamProfile: profile,
    stats: { bandwidth: 900_000, hlsThroughputSampleCount: 3 },
  });
  assert.equal(result.code, "bandwidth_insufficient");
  assert.equal(
    result.message,
    "Connection slowed. Building buffer… 0.90 Mbps available · about 2.7 Mbps needed.",
  );
  assert.doesNotMatch(result.message, /fixed|720p|quality/i);
  assert.ok(result.requiredKbps > 2_600);
});

test("does not blame bandwidth when measured throughput is sufficient", () => {
  assert.equal(assessBandwidthHealth({
    bufferingMs: 9_000,
    streamProfile: profile,
    stats: { bandwidth: 4_000_000, hlsThroughputSampleCount: 3 },
  }), null);
});

test("reports an unstable connection when retries empty the buffer", () => {
  const result = assessBandwidthHealth({
    bufferingMs: 9_000,
    streamProfile: profile,
    stats: { hlsTimeoutCount: 1, hlsBufferedAheadSeconds: 0 },
  });
  assert.equal(result.code, "network_unstable");
  assert.equal(
    result.message,
    "Connection interrupted. Rebuilding buffer…",
  );
  assert.doesNotMatch(result.message, /fixed|720p|quality/i);
});
