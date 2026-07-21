export const PLAYER_RECOVERY_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

export function playbackRecoveryDelayMs(attempt) {
  const index = Math.max(0, Math.floor(Number(attempt) || 1) - 1);
  return PLAYER_RECOVERY_BACKOFF_MS[Math.min(index, PLAYER_RECOVERY_BACKOFF_MS.length - 1)];
}

export function hasSeekPlaybackProgress(_before, after, targetTimeSeconds, minimumClockProgressMs = 250) {
  const targetMs = Math.max(0, Number(targetTimeSeconds) || 0) * 1000;
  const afterClockMs = Math.max(
    Number(after?.videoCurrentTimeMs) || 0,
    Number(after?.audioCurrentTimeMs) || 0,
  );
  return afterClockMs >= targetMs + minimumClockProgressMs;
}

export function hasRecoveryPlaybackProgress({
  status,
  baselineTime,
  currentTime,
  hasVideo = false,
  videoFrameRenderCount = 0,
  minimumProgressSeconds = 0.25,
}) {
  if (status !== "playing") return false;
  if (hasVideo && !(Number(videoFrameRenderCount) > 0)) return false;
  const baseline = Number(baselineTime);
  const current = Number(currentTime);
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) return false;
  return current >= baseline + minimumProgressSeconds;
}

export function resolvePlaybackPosition({ engineTime, fallbackTime, duration }) {
  const maximum = Number(duration) > 0 ? Number(duration) : Infinity;
  const engine = Number(engineTime);
  const fallback = Number(fallbackTime);
  const selected = Number.isFinite(engine)
    ? engine
    : Number.isFinite(fallback) ? fallback : 0;
  return Math.max(0, Math.min(maximum, selected));
}

export function buildFreshPlaybackSessionRequest(request, startTime, { autoplay = true } = {}) {
  const position = Math.max(0, Number(startTime) || 0);
  const plex = request?.meta?.plex;
  if (plex?.ratingKey) {
    return {
      endpoint: "/api/plex/play",
      body: {
        ratingKey: plex.ratingKey,
        subtitleStreamID: plex.activeSubtitleID || null,
        audioStreamID: plex.activeAudioID || null,
        offset: position * 1000,
        recovery: true,
        autoplay,
      },
    };
  }
  if (request?.meta?.sourceUrl) {
    return {
      endpoint: "/api/play",
      body: {
        url: request.meta.sourceUrl,
        startTime: position,
        autoplay,
        reason: "recovery",
      },
    };
  }
  return null;
}
