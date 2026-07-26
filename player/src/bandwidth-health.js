const BANDWIDTH_WARNING_AFTER_MS = 8_000;
const REQUIRED_HEADROOM = 1.15;

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function formatMbps(kbps) {
  const mbps = positiveNumber(kbps) / 1000;
  return `${mbps < 1 ? mbps.toFixed(2) : mbps.toFixed(1)} Mbps`;
}

export function assessBandwidthHealth({ bufferingMs = 0, streamProfile = null, stats = null } = {}) {
  if (bufferingMs < BANDWIDTH_WARNING_AFTER_MS || !streamProfile || !stats) return null;
  const mediaKbps = positiveNumber(streamProfile.videoKbps) + positiveNumber(streamProfile.audioKbps);
  const requiredKbps = mediaKbps * REQUIRED_HEADROOM;
  const availableKbps = positiveNumber(stats.bandwidth) / 1000;
  const sampleCount = positiveNumber(stats.hlsThroughputSampleCount);

  if (requiredKbps && availableKbps && sampleCount >= 2 && availableKbps < requiredKbps) {
    return {
      code: "bandwidth_insufficient",
      availableKbps: Math.round(availableKbps),
      requiredKbps: Math.round(requiredKbps),
      message: `Connection slowed. Building buffer… ${formatMbps(availableKbps)} available · about ${formatMbps(requiredKbps)} needed.`,
    };
  }

  const connectionFailures = positiveNumber(stats.hlsTimeoutCount)
    + positiveNumber(stats.hlsFailureCount)
    + positiveNumber(stats.hlsRetryWaitingSegments);
  const nearlyEmpty = positiveNumber(stats.hlsBufferedAheadSeconds) < 2;
  if (connectionFailures && nearlyEmpty) {
    return {
      code: "network_unstable",
      availableKbps: availableKbps ? Math.round(availableKbps) : null,
      requiredKbps: requiredKbps ? Math.round(requiredKbps) : null,
      message: "Connection interrupted. Rebuilding buffer…",
    };
  }
  return null;
}
