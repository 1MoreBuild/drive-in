import assert from "node:assert/strict";
import test from "node:test";

import {
  PageMemoryMonitor,
  summarizePageMemory,
} from "../../src/telemetry/page-memory-monitor.js";

test("page memory summary keeps total bytes and bounded type breakdown", () => {
  const summary = summarizePageMemory({
    bytes: 1200,
    breakdown: [
      { bytes: 200, types: ["DOM"] },
      { bytes: 900, types: ["JavaScript", "Shared"] },
      { bytes: -1, types: ["invalid"] },
    ],
  }, { timestamp: 123, durationMs: 45.6 });

  assert.deepEqual(summary, {
    startedAt: null,
    timestamp: 123,
    bytes: 1200,
    durationMs: 46,
    breakdown: [
      { bytes: 900, types: ["JavaScript", "Shared"] },
      { bytes: 200, types: ["DOM"] },
    ],
  });
});

test("page memory monitor samples once per interval", async () => {
  let now = 1_000;
  let wallNow = 10_000;
  let calls = 0;
  const monitor = new PageMemoryMonitor({
    crossOriginIsolated: true,
    intervalMs: 300_000,
    monotonicNow: () => now,
    wallNow: () => {
      const value = wallNow;
      wallNow += 25;
      return value;
    },
    performanceApi: {
      measureUserAgentSpecificMemory: async () => {
        calls += 1;
        now += 25;
        return { bytes: 42, breakdown: [] };
      },
    },
  });

  assert.equal((await monitor.measure()).bytes, 42);
  assert.equal(await monitor.measure(), null);
  now += 300_000;
  assert.equal((await monitor.measure()).bytes, 42);
  assert.equal(calls, 2);
  assert.equal(monitor.lastSample.durationMs, 25);
  assert.equal(monitor.lastSample.startedAt, 10_050);
  assert.equal(monitor.lastSample.timestamp, 10_075);

  monitor.allowNextMeasurement();
  assert.equal((await monitor.measure()).bytes, 42);
  assert.equal(calls, 3);
});

test("page memory monitor explains unavailable measurements", () => {
  const isolatedWithoutApi = new PageMemoryMonitor({
    crossOriginIsolated: true,
    performanceApi: {},
  });
  assert.equal(isolatedWithoutApi.supported, false);
  assert.equal(isolatedWithoutApi.unavailableReason, "api-unavailable");

  const unisolated = new PageMemoryMonitor({
    crossOriginIsolated: false,
    performanceApi: { measureUserAgentSpecificMemory() {} },
  });
  assert.equal(unisolated.unavailableReason, "not-cross-origin-isolated");
});
