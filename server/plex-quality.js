export const PLEX_VIDEO_RESOLUTION = "1280x720";
export const DEFAULT_PLEX_VIDEO_BITRATE_KBPS = 4800;
export const MIN_PLEX_VIDEO_BITRATE_KBPS = 4000;
export const MAX_PLEX_VIDEO_BITRATE_KBPS = 4800;

export function normalizePlexVideoBitrate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    && parsed >= MIN_PLEX_VIDEO_BITRATE_KBPS
    && parsed <= MAX_PLEX_VIDEO_BITRATE_KBPS
    ? Math.floor(parsed)
    : DEFAULT_PLEX_VIDEO_BITRATE_KBPS;
}

export function createFixedPlexMediaSource(url) {
  return { type: "hls", url };
}
