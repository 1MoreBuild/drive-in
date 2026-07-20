export const PLEX_VIDEO_RESOLUTION = "1280x720";
export const DEFAULT_PLEX_VIDEO_BITRATE_KBPS = 3000;

export function normalizePlexVideoBitrate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 500 && parsed <= 20_000
    ? Math.floor(parsed)
    : DEFAULT_PLEX_VIDEO_BITRATE_KBPS;
}

export function createFixedPlexMediaSource(url) {
  return { type: "hls", url };
}
