export function hasHlsStartupBuffer({
  decodedReady,
  network = null,
  mediaTime = 0,
  duration = 0,
  requiredStartSeconds = 15,
}) {
  if (!decodedReady) return false;
  if (!network) return true;
  if (!network.activePlaylistCount) {
    return ![
      network.pendingSegments,
      network.activeDownloads,
      network.queuedSegments,
      network.retryWaitingSegments,
    ].some((value) => Number(value) > 0);
  }
  const remainingSeconds = Number.isFinite(duration) && duration > 0
    ? Math.max(0, duration - mediaTime)
    : requiredStartSeconds;
  const requiredSeconds = Math.min(requiredStartSeconds, remainingSeconds);
  return network.bufferedAheadSeconds >= requiredSeconds
    || (network.pendingSegments === 0 && network.bufferedAheadSeconds > 0);
}
