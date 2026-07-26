import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PLEX_VIDEO_BITRATE_KBPS,
  MAX_PLEX_VIDEO_BITRATE_KBPS,
  MIN_PLEX_VIDEO_BITRATE_KBPS,
  PLEX_VIDEO_RESOLUTION,
  createFixedPlexMediaSource,
  normalizePlexVideoBitrate,
} from "../../plex-quality.js";

test("Plex playback stays at the fixed 720p profile", () => {
  assert.equal(PLEX_VIDEO_RESOLUTION, "1280x720");
  assert.equal(DEFAULT_PLEX_VIDEO_BITRATE_KBPS, 4800);
  assert.equal(MIN_PLEX_VIDEO_BITRATE_KBPS, 4000);
  assert.equal(MAX_PLEX_VIDEO_BITRATE_KBPS, 4800);
  assert.deepEqual(createFixedPlexMediaSource("/plex.m3u8"), {
    type: "hls",
    url: "/plex.m3u8",
  });
});

test("Plex fixed bitrate accepts a bounded override", () => {
  assert.equal(normalizePlexVideoBitrate("4000"), 4000);
  assert.equal(normalizePlexVideoBitrate("4400.9"), 4400);
  assert.equal(normalizePlexVideoBitrate("4800"), 4800);
  assert.equal(normalizePlexVideoBitrate("3500"), 4800);
  assert.equal(normalizePlexVideoBitrate("5000"), 4800);
  assert.equal(normalizePlexVideoBitrate("bad"), 4800);
  assert.equal(normalizePlexVideoBitrate(100), 4800);
  assert.equal(normalizePlexVideoBitrate(50_000), 4800);
});
