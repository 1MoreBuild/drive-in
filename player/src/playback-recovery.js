export const PLAYER_RECOVERY_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

export function playbackRecoveryDelayMs(attempt) {
  const index = Math.max(0, Math.floor(Number(attempt) || 1) - 1);
  return PLAYER_RECOVERY_BACKOFF_MS[Math.min(index, PLAYER_RECOVERY_BACKOFF_MS.length - 1)];
}

export function buildFreshPlaybackSessionRequest(request, startTime) {
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
      },
    };
  }
  if (request?.meta?.sourceUrl) {
    return {
      endpoint: "/api/play",
      body: {
        url: request.meta.sourceUrl,
        startTime: position,
        autoplay: true,
        reason: "recovery",
      },
    };
  }
  return null;
}
