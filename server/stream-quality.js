export const WINDOWED_TARGET_HEIGHT = 720;
export const FULLSCREEN_TARGET_HEIGHT = 1080;
const FULLSCREEN_VIDEO_WIDTH_THRESHOLD = 1600;

export function normalizeTargetHeight(value) {
  return Number(value) >= FULLSCREEN_TARGET_HEIGHT
    ? FULLSCREEN_TARGET_HEIGHT
    : WINDOWED_TARGET_HEIGHT;
}

export function targetHeightForViewport(viewport) {
  const visual = viewport?.visualViewport;
  const width = Number(visual?.width ?? viewport?.innerWidth);
  const height = Number(visual?.height ?? viewport?.innerHeight);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return WINDOWED_TARGET_HEIGHT;
  }
  const displayedVideoWidth = Math.min(width, height * (16 / 9));
  return displayedVideoWidth >= FULLSCREEN_VIDEO_WIDTH_THRESHOLD
    ? FULLSCREEN_TARGET_HEIGHT
    : WINDOWED_TARGET_HEIGHT;
}

export function buildFormatSelector({ targetHeight = WINDOWED_TARGET_HEIGHT, maxVideoKbps = 4800 } = {}) {
  const height = normalizeTargetHeight(targetHeight);
  const bitrate = Math.max(500, Math.floor(Number(maxVideoKbps) || 4800));
  const avc = `bv[vcodec^=avc1][height<=${height}][tbr<=${bitrate}]`;
  const anyCodec = `bv[height<=${height}][tbr<=${bitrate}]`;
  return [
    `${avc}[fps>=50]+ba[acodec^=mp4a]`,
    `${avc}[fps>=50]+ba*`,
    `${avc}+ba[acodec^=mp4a]`,
    `${avc}+ba*`,
    `${anyCodec}[fps>=50]+ba*`,
    `${anyCodec}+ba*`,
    `b*[height<=${height}][fps>=50]`,
    `b*[height<=${height}]`,
    "b*",
  ].join("/");
}
