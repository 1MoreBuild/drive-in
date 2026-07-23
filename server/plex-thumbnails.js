export const PLEX_THUMBNAIL_PRESETS = Object.freeze({
  landscape: Object.freeze({ width: 600, height: 338 }),
  poster: Object.freeze({ width: 390, height: 585 }),
});

const MIN_DIMENSION = 64;
const MAX_DIMENSION = 1280;

export function plexThumbnailProxyUrl(path, preset = "landscape") {
  if (!path) return null;
  const dimensions = PLEX_THUMBNAIL_PRESETS[preset];
  if (!dimensions) throw new TypeError(`Unknown Plex thumbnail preset: ${preset}`);
  const params = new URLSearchParams({
    path,
    width: String(dimensions.width),
    height: String(dimensions.height),
  });
  return `/api/plex/thumb?${params}`;
}

export function parsePlexThumbnailDimensions(widthValue, heightValue) {
  const missingWidth = widthValue == null || widthValue === "";
  const missingHeight = heightValue == null || heightValue === "";
  if (missingWidth && missingHeight) return null;
  const width = Number(widthValue);
  const height = Number(heightValue);
  if (
    missingWidth
    || missingHeight
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < MIN_DIMENSION
    || height < MIN_DIMENSION
    || width > MAX_DIMENSION
    || height > MAX_DIMENSION
  ) {
    throw new RangeError("Invalid Plex thumbnail dimensions");
  }
  return { width, height };
}

export function buildPlexThumbnailUpstreamUrl({ plexUrl, path, token, dimensions = null }) {
  const plexBase = new URL(plexUrl);
  const source = new URL(path, plexBase);
  if (source.origin !== plexBase.origin) throw new TypeError("Invalid Plex thumbnail path");

  if (!dimensions) {
    source.searchParams.set("X-Plex-Token", token);
    return source;
  }

  const upstream = new URL("/photo/:/transcode", plexBase);
  upstream.searchParams.set("width", String(dimensions.width));
  upstream.searchParams.set("height", String(dimensions.height));
  upstream.searchParams.set("minSize", "1");
  upstream.searchParams.set("upscale", "0");
  upstream.searchParams.set("url", `${source.pathname}${source.search}`);
  upstream.searchParams.set("X-Plex-Token", token);
  return upstream;
}
