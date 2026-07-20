import assert from "node:assert/strict";
import test from "node:test";

import {
  buildYoutubeLiveWindow,
  parseYoutubeLivePlaylist,
  segmentUrlForSequence,
  sequenceForTime,
} from "../youtube-live-dvr.js";

const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-PROGRAM-DATE-TIME:2026-07-20T00:00:00.000Z
#EXTINF:2.0,
https://rr.googlevideo.com/videoplayback/playlist_type/DVR/sq/100/dur/2/file/seg.ts
#EXTINF:2.0,
https://rr.googlevideo.com/videoplayback/playlist_type/DVR/sq/101/dur/2/file/seg.ts
`;

test("parses a YouTube DVR playlist into an absolute timeline", () => {
  const session = parseYoutubeLivePlaylist(playlist);
  assert.equal(session.latestSequence, 101);
  assert.equal(session.segmentDuration, 2);
  assert.equal(session.startedAt, Date.parse("2026-07-19T23:56:40.000Z") / 1000);
  assert.equal(sequenceForTime(session, session.startedAt + 50), 25);
});

test("builds a bounded window while retaining the full DVR start", () => {
  const session = parseYoutubeLivePlaylist(playlist);
  const body = buildYoutubeLiveWindow(session, {
    cursorSequence: 50,
    sessionId: "variant-1",
    windowAheadSeconds: 6,
    windowBehindSeconds: 0,
  });
  assert.match(body, /#EXT-X-MEDIA-SEQUENCE:50/);
  assert.match(body, /live-segment\?id=variant-1&sq=50/);
  assert.match(body, /live-segment\?id=variant-1&sq=52/);
  assert.doesNotMatch(body, /sq=53/);
});

test("advertises a bounded future runway for low-latency playback", () => {
  const session = parseYoutubeLivePlaylist(playlist);
  const body = buildYoutubeLiveWindow(session, {
    cursorSequence: 100,
    sessionId: "variant-1",
    windowAheadSeconds: 6,
    windowBehindSeconds: 0,
  });
  assert.match(body, /live-segment\?id=variant-1&sq=102/);
  assert.doesNotMatch(body, /sq=103/);
});

test("reconstructs only validated sequence URLs", () => {
  const session = parseYoutubeLivePlaylist(playlist);
  assert.match(segmentUrlForSequence(session, 10), /\/sq\/10\//);
  assert.equal(segmentUrlForSequence(session, -1), null);
  assert.equal(segmentUrlForSequence(session, 102), null);
});

test("ignores ordinary HLS playlists", () => {
  assert.equal(parseYoutubeLivePlaylist("#EXTM3U\n#EXTINF:2,\nhttps://example.com/1.ts"), null);
});
