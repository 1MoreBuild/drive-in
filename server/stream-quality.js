export const WINDOWED_TARGET_HEIGHT = 720;
export const LOW_FPS_TARGET_HEIGHT = 1080;

export function normalizeTargetHeight(_value) {
  return WINDOWED_TARGET_HEIGHT;
}

export function targetHeightForViewport(_viewport) {
  return WINDOWED_TARGET_HEIGHT;
}

export function buildFormatSelector({ targetHeight = WINDOWED_TARGET_HEIGHT, maxVideoKbps = 4800 } = {}) {
  const motionHeight = normalizeTargetHeight(targetHeight);
  const detailHeight = Math.max(motionHeight, LOW_FPS_TARGET_HEIGHT);
  const bitrate = Math.max(500, Math.floor(Number(maxVideoKbps) || 4800));
  const avcMotion = `bv[vcodec^=avc1][height<=${motionHeight}][tbr<=${bitrate}][fps>=50]`;
  const anyMotion = `bv[height<=${motionHeight}][tbr<=${bitrate}][fps>=50]`;
  const avcDetail = `bv[vcodec^=avc1][height<=${detailHeight}][tbr<=${bitrate}][fps<50]`;
  const anyDetail = `bv[height<=${detailHeight}][tbr<=${bitrate}][fps<50]`;
  return [
    `${avcMotion}+ba[acodec^=mp4a]`,
    `${avcMotion}+ba*`,
    `${anyMotion}+ba[acodec^=mp4a]`,
    `${anyMotion}+ba*`,
    `${avcDetail}+ba[acodec^=mp4a]`,
    `${avcDetail}+ba*`,
    `${anyDetail}+ba[acodec^=mp4a]`,
    `${anyDetail}+ba*`,
    `b*[height<=${motionHeight}][fps>=50]`,
    `b*[height<=${detailHeight}][fps<50]`,
    `b*[height<=${motionHeight}]`,
    "b*",
  ].join("/");
}
