import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlexThumbnailUpstreamUrl,
  parsePlexThumbnailDimensions,
  plexThumbnailProxyUrl,
} from "../../plex-thumbnails.js";

test("builds stable local URLs for card-sized Plex posters", () => {
  assert.equal(
    plexThumbnailProxyUrl("/library/metadata/42/thumb/7", "poster"),
    "/api/plex/thumb?path=%2Flibrary%2Fmetadata%2F42%2Fthumb%2F7&width=390&height=585",
  );
});

test("accepts bounded thumbnail dimensions and rejects partial sizes", () => {
  assert.deepEqual(parsePlexThumbnailDimensions("600", "338"), { width: 600, height: 338 });
  assert.equal(parsePlexThumbnailDimensions(undefined, undefined), null);
  assert.throws(() => parsePlexThumbnailDimensions("600", ""), /Invalid Plex thumbnail dimensions/);
  assert.throws(() => parsePlexThumbnailDimensions("4000", "3000"), /Invalid Plex thumbnail dimensions/);
});

test("uses Plex image transcode without exposing a cross-origin source", () => {
  const upstream = buildPlexThumbnailUpstreamUrl({
    plexUrl: "http://127.0.0.1:32400",
    path: "/library/metadata/42/thumb/7",
    token: "secret",
    dimensions: { width: 390, height: 585 },
  });
  assert.equal(upstream.origin, "http://127.0.0.1:32400");
  assert.equal(upstream.pathname, "/photo/:/transcode");
  assert.equal(upstream.searchParams.get("width"), "390");
  assert.equal(upstream.searchParams.get("height"), "585");
  assert.equal(upstream.searchParams.get("url"), "/library/metadata/42/thumb/7");
  assert.equal(upstream.searchParams.get("X-Plex-Token"), "secret");
  assert.throws(() => buildPlexThumbnailUpstreamUrl({
    plexUrl: "http://127.0.0.1:32400",
    path: "https://example.com/poster.jpg",
    token: "secret",
  }), /Invalid Plex thumbnail path/);
});
