const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BREAKDOWN_ENTRIES = 12;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function summarizePageMemory(result, {
  startedAt = null,
  timestamp = Date.now(),
  durationMs = 0,
} = {}) {
  const breakdown = Array.isArray(result?.breakdown)
    ? result.breakdown
      .map((entry) => ({
        bytes: finiteNonNegative(entry?.bytes),
        types: Array.isArray(entry?.types)
          ? entry.types.filter((type) => typeof type === "string").slice(0, 8)
          : [],
      }))
      .filter((entry) => entry.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, MAX_BREAKDOWN_ENTRIES)
    : [];

  return {
    startedAt,
    timestamp,
    bytes: finiteNonNegative(result?.bytes),
    durationMs: Math.round(finiteNonNegative(durationMs)),
    breakdown,
  };
}

export class PageMemoryMonitor {
  constructor({
    performanceApi = globalThis.performance,
    crossOriginIsolated = globalThis.crossOriginIsolated === true,
    intervalMs = DEFAULT_INTERVAL_MS,
    monotonicNow = () => performanceApi?.now?.() ?? Date.now(),
    wallNow = () => Date.now(),
  } = {}) {
    this.performanceApi = performanceApi;
    this.crossOriginIsolated = crossOriginIsolated;
    this.intervalMs = intervalMs;
    this.monotonicNow = monotonicNow;
    this.wallNow = wallNow;
    this.inFlight = false;
    this.lastAttemptAt = Number.NEGATIVE_INFINITY;
    this.lastSample = null;
    this.lastError = null;
  }

  get supported() {
    return this.crossOriginIsolated
      && typeof this.performanceApi?.measureUserAgentSpecificMemory === "function";
  }

  get unavailableReason() {
    if (!this.crossOriginIsolated) return "not-cross-origin-isolated";
    if (typeof this.performanceApi?.measureUserAgentSpecificMemory !== "function") return "api-unavailable";
    return null;
  }

  allowNextMeasurement() {
    this.lastAttemptAt = Number.NEGATIVE_INFINITY;
  }

  async measure({ force = false } = {}) {
    if (!this.supported || this.inFlight) return null;
    const startedAt = this.monotonicNow();
    if (!force && startedAt - this.lastAttemptAt < this.intervalMs) return null;

    this.inFlight = true;
    this.lastAttemptAt = startedAt;
    const wallStartedAt = this.wallNow();
    try {
      const result = await this.performanceApi.measureUserAgentSpecificMemory();
      const completedAt = this.monotonicNow();
      this.lastSample = summarizePageMemory(result, {
        startedAt: wallStartedAt,
        timestamp: this.wallNow(),
        durationMs: completedAt - startedAt,
      });
      this.lastError = null;
      return this.lastSample;
    } catch (error) {
      this.lastError = error?.message || String(error);
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
}
