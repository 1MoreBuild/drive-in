import assert from "node:assert/strict";
import test from "node:test";
import { rewriteHlsUris, rewriteTranscodePlaylist } from "../../hls-manifest.js";

test("transcode playlists rewrite initialization and media segments", () => {
  const result = rewriteTranscodePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg0.m4s\n');
  assert.match(result, /URI="\/api\/transcode\/segment\?name=init.mp4"/);
  assert.match(result, /\n\/api\/transcode\/segment\?name=seg0.m4s\n/);
});

test("generic URI rewriting covers tags and lines exactly once", () => {
  const uris = [];
  const result = rewriteHlsUris('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MEDIA:URI="audio.m3u8"\n\nvideo.m3u8\n', (uri) => {
    uris.push(uri);
    return `proxy/${uri}`;
  });
  assert.deepEqual(uris, ["key.bin", "audio.m3u8", "video.m3u8"]);
  assert.match(result, /URI="proxy\/key.bin"/);
});
