import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { downloadSubtitlesDirect } from "../../url-subtitles.js";

test("URL SRT downloads are converted and saved as usable VTT", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "drive-in-srt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createServer((_req, res) => res.end("1\r\n00:00:00,000 --> 00:00:01,000\r\nHello\r\n"));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const errors = [];
  const result = await downloadSubtitlesDirect([
    { lang: "en", name: "English", ext: "srt", url: `http://127.0.0.1:${server.address().port}/sub.srt` },
  ], dir, { log: { warn: (error) => errors.push(error), error: (error) => errors.push(error) } });
  assert.deepEqual(errors, []);
  assert.equal(result.length, 1);
  const vtt = await readFile(resolve(dir, result[0].filename), "utf8");
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.000\nHello/);
});
