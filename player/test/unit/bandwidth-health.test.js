import assert from "node:assert/strict";
import test from "node:test";
import { assessBandwidthHealth, streamQualityLabel } from "../../src/bandwidth-health.js";

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

test("explains measured bandwidth shortage without changing quality", () => {
  const result = assessBandwidthHealth({
    bufferingMs: 9_000,
    streamProfile: profile,
    stats: { bandwidth: 900_000, hlsThroughputSampleCount: 3 },
  });
  assert.equal(result.code, "bandwidth_insufficient");
  assert.match(result.message, /fixed 720p60/);
  assert.match(result.message, /available/);
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
  assert.match(result.message, /instead of lowering quality/);
});

test("quality label omits an unknown frame rate", () => {
  assert.equal(streamQualityLabel({ height: 720 }), "720p");
});
