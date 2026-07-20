const DURATION_END_TOLERANCE_SECONDS = 0.02;
export const DRAINED_TAIL_TOLERANCE_SECONDS = 0.05;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function getPlaybackEndReason({
  duration,
  mediaTime,
  hasAudio,
  hasVideo,
  audioEnded,
  videoEnded,
  audioBufferedSeconds,
  videoBufferedSeconds,
  ignoreDurationBoundary = false,
}) {
  const safeDuration = finiteNonNegative(duration);
  const safeMediaTime = finiteNonNegative(mediaTime);

  if (
    !ignoreDurationBoundary
    && safeDuration > 0
    && safeMediaTime >= safeDuration - DURATION_END_TOLERANCE_SECONDS
  ) {
    return "duration-boundary";
  }

  if (!hasAudio && !hasVideo) return null;

  const sourcesEnded = (!hasAudio || audioEnded) && (!hasVideo || videoEnded);
  if (!sourcesEnded) return null;

  const audioDrained = !hasAudio
    || finiteNonNegative(audioBufferedSeconds) <= DRAINED_TAIL_TOLERANCE_SECONDS;
  const videoDrained = !hasVideo
    || finiteNonNegative(videoBufferedSeconds) <= DRAINED_TAIL_TOLERANCE_SECONDS;

  return audioDrained && videoDrained ? "sources-drained" : null;
}
