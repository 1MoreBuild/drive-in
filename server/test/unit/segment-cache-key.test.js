import assert from "node:assert/strict";
import test from "node:test";
import { computeSegmentCacheKey, createSegmentCachePathResolver } from "../../segment-cache-key.js";

test("YouTube signed URL refresh keeps the same logical cache key", () => {
  const first = computeSegmentCacheKey(
    "https://rr1---sn.googlevideo.com/videoplayback?id=abc&itag=298&clen=9000&lmt=123&expire=1&sig=old",
    "bytes=0-1999",
  );
  const refreshed = computeSegmentCacheKey(
    "https://rr2---sn.googlevideo.com/videoplayback?id=abc&itag=298&clen=9000&lmt=123&expire=2&sig=new",
    "bytes=0-1999",
  );
  assert.equal(first.sourceType, "youtube");
  assert.equal(first.filenameKey, refreshed.filenameKey);
});

test("Bilibili cache key ignores volatile query signatures", () => {
  const first = computeSegmentCacheKey("https://xy.bilivideo.com/upgcxcode/a/video.m4s?deadline=1&upsig=old", "bytes=20-40");
  const refreshed = computeSegmentCacheKey("https://xy.bilivideo.com/upgcxcode/a/video.m4s?deadline=2&upsig=new", "bytes=20-40");
  assert.equal(first.sourceType, "bilibili");
  assert.equal(first.filenameKey, refreshed.filenameKey);
});

test("fallback cache keys keep byte ranges separate", () => {
  const first = computeSegmentCacheKey("https://cdn.example.test/video.bin", "bytes=0-99");
  const second = computeSegmentCacheKey("https://cdn.example.test/video.bin", "bytes=100-199");
  assert.notEqual(first.filenameKey, second.filenameKey);
});

test("cache paths remain inside the configured root", () => {
  const resolvePaths = createSegmentCachePathResolver("/tmp/drive-in-segment-test");
  const paths = resolvePaths("https://cdn.example.test/../../escape.ts");
  assert.match(paths.dataPath, /^\/tmp\/drive-in-segment-test\/[a-f0-9]{64}\.dat$/);
  assert.match(paths.metaPath, /^\/tmp\/drive-in-segment-test\/[a-f0-9]{64}\.meta$/);
});
