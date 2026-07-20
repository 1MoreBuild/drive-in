export const WINDOWED_TARGET_HEIGHT = 720;

export function normalizeTargetHeight(_value) {
  return WINDOWED_TARGET_HEIGHT;
}

export function targetHeightForViewport(_viewport) {
  return WINDOWED_TARGET_HEIGHT;
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
