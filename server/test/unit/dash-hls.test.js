import assert from "node:assert/strict";
import test from "node:test";
import { buildDashHlsSession, parseMp4Structure } from "../../dash-hls.js";

test("parses a bounded version-zero sidx", () => {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(44, 0);
  buffer.write("sidx", 4, "ascii");
  buffer.writeUInt32BE(1, 12);
  buffer.writeUInt32BE(1000, 16);
  buffer.writeUInt32BE(0, 20);
  buffer.writeUInt32BE(0, 24);
  buffer.writeUInt16BE(0, 28);
  buffer.writeUInt16BE(1, 30);
  buffer.writeUInt32BE(1000, 32);
  buffer.writeUInt32BE(5000, 36);
  const result = parseMp4Structure(buffer, 1044);
  assert.deepEqual(result.segments, [{
    start: 44,
    end: 1043,
    duration: 5,
    durationTicks: 5000,
  }]);
});

test("malformed MP4 box sizes fail closed", () => {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32BE(4096, 0);
  buffer.write("sidx", 4, "ascii");
  assert.deepEqual(parseMp4Structure(buffer).segments, []);
});

test("builds separate audio and video fMP4 playlists", () => {
  const session = buildDashHlsSession({
    sessionId: "pair-1",
    videoFormat: { vcodec: "avc1.4d401f", tbr: 1800, width: 1280, height: 720, fps: 60 },
    audioFormat: { acodec: "mp4a.40.2", tbr: 128 },
    videoProxyId: "video",
    audioProxyId: "audio",
    videoInfo: { segments: [{ start: 10, end: 20, duration: 2 }], initEnd: 9 },
    audioInfo: { segments: [{ start: 8, end: 18, duration: 2 }], initEnd: 7 },
  });
  assert.match(session.master, /RESOLUTION=1280x720,FRAME-RATE=60/);
  assert.match(session.master, /audio\.m3u8/);
  assert.match(session.video, /\/api\/dash\/seg-video\/0\.mp4/);
  assert.match(session.audio, /\/api\/dash\/seg-audio\/0\.mp4/);
});
