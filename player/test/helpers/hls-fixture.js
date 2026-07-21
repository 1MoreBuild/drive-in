import { HlsSegmentPrefetcher } from "../../src/engine/hls-segment-prefetcher.js";

export const TEST_ORIGIN = "https://drivein.test/";

export function segment(index, duration = 5) {
  return { url: new URL(`${index}.m4s`, TEST_ORIGIN).href, duration };
}

export function cachedEntry(body, extra = {}) {
  const bytes = new TextEncoder().encode(body).buffer;
  return {
    bytes,
    byteLength: bytes.byteLength,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "video/mp4"]],
    ...extra,
  };
}

export function playlistBody(segments) {
  return `#EXTM3U\n${segments.map((item) => `#EXTINF:${item.duration},\n${item.url}`).join("\n")}\n`;
}

export function createPrefetcher(options = {}) {
  return new HlsSegmentPrefetcher({
    baseUrl: TEST_ORIGIN,
    logger: { warn() {} },
    ...options,
  });
}

export async function waitFor(check, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
