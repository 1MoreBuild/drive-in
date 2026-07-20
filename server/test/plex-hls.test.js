import assert from "node:assert/strict";
import test from "node:test";
import { rewritePlexHlsManifest, trimPlexHlsResumePlaceholders } from "../plex-hls.js";

test("rewrites Plex transcode segment URLs", () => {
  const result = rewritePlexHlsManifest("#EXTM3U\n/video/:/transcode/universal/session/seg.ts\n");
  assert.match(result, /\/api\/plex\/hls\/session\/seg\.ts/);
});

test("drops placeholder segments covered by the resume offset", () => {
  const trims = [];
  const result = trimPlexHlsResumePlaceholders([
    "#EXTM3U",
    "#EXT-X-MEDIA-SEQUENCE:10",
    "#EXT-X-START:TIME-OFFSET=8",
    "#EXTINF:4,",
    "one.ts",
    "#EXTINF:4,",
    "two.ts",
    "#EXTINF:4,",
    "three.ts",
    "",
  ].join("\n"), { onTrim: (details) => trims.push(details) });
  assert.doesNotMatch(result, /one\.ts|two\.ts|EXT-X-START/);
  assert.match(result, /#EXT-X-MEDIA-SEQUENCE:12/);
  assert.match(result, /three\.ts/);
  assert.deepEqual(trims, [{ resumeOffset: 8, droppedSegments: 2, nextMediaSequence: 12 }]);
});

test("leaves an invalid resume playlist unchanged", () => {
  const body = "#EXTM3U\n#EXT-X-START:TIME-OFFSET=8\n#EXTINF:not-a-number,\none.ts\n";
  assert.equal(trimPlexHlsResumePlaceholders(body), body);
});
