import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PLEX_VIDEO_BITRATE_KBPS,
  PLEX_VIDEO_RESOLUTION,
  createFixedPlexMediaSource,
  normalizePlexVideoBitrate,
} from "../../plex-quality.js";

test("Plex playback stays at the fixed 720p profile", () => {
  assert.equal(PLEX_VIDEO_RESOLUTION, "1280x720");
  assert.equal(DEFAULT_PLEX_VIDEO_BITRATE_KBPS, 4800);
  assert.deepEqual(createFixedPlexMediaSource("/plex.m3u8"), {
    type: "hls",
    url: "/plex.m3u8",
  });
});

test("Plex fixed bitrate accepts a bounded override", () => {
  assert.equal(normalizePlexVideoBitrate("3500"), 3500);
  assert.equal(normalizePlexVideoBitrate("bad"), 4800);
  assert.equal(normalizePlexVideoBitrate(100), 4800);
  assert.equal(normalizePlexVideoBitrate(50_000), 4800);
});
