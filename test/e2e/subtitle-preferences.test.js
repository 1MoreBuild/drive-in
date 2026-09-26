import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { connectPlayer, postJson, startDriveInServer } from "./helpers.js";

test("service restores Plex text subtitles on a new client and remembers Off", async (t) => {
  let holdMetadata = null;
  const plex = createServer((req, res) => {
    if (req.url.startsWith("/library/metadata/")) {
      const metadata = JSON.stringify({ MediaContainer: { Metadata: [{ title: "Subtitle fixture", duration: 10000,
        Media: [{ Part: [{ id: "1", Stream: [{ id: 8, codec: "srt", streamType: 3, key: "/captions.srt", languageCode: "zho", language: "中文" }] }] }],
      }] } });
      if (holdMetadata) {
        const hold = holdMetadata;
        holdMetadata = null;
        hold(() => res.end(metadata));
      } else res.end(metadata);
    } else if (req.url.startsWith("/captions.srt")) {
      res.end("1\n00:00:01,000 --> 00:00:04,000\n中文字幕\n");
    } else if (req.url.includes("/start.m3u8")) {
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n/video/:/transcode/universal/session/test/base/index.m3u8\n");
    } else res.end("{}");
  });
  await new Promise((resolve) => plex.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { plex.closeAllConnections(); plex.close(resolve); }));
  const { baseUrl } = await startDriveInServer(t, { PLEX_URL: `http://127.0.0.1:${plex.address().port}` });
  let player = await connectPlayer(baseUrl, "first-browser");
  await player.next("playerAccepted");
  const select = async (id) => fetch(`${baseUrl}/api/plex/subtitles/3993/selection`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subtitleStreamID: id }),
  });
  assert.equal((await select(8)).status, 200);
  await player.close();
  player = await connectPlayer(baseUrl, "new-browser-with-no-local-storage");
  t.after(() => player.close());
  await player.next("playerAccepted");
  assert.equal((await postJson(baseUrl, "/api/plex/play", { ratingKey: "3993" })).response.status, 200);
  const restored = await player.next("play");
  assert.equal(restored.plex.activeSubtitleID, 8);
  assert.equal(restored.plex.subtitles[0].delivery, "external");
  assert.equal((await select(999)).status, 404);
  assert.equal((await select(null)).status, 200);
  // Stale browser storage cannot override service-owned Off.
  await postJson(baseUrl, "/api/plex/play", { ratingKey: "3993", preferredSubtitleLanguages: ["中文"] });
  assert.equal((await player.next("play")).plex.activeSubtitleID, null);
  // Explicit CLI-style selection is saved too, not just the browser PUT route.
  await postJson(baseUrl, "/api/plex/play", { ratingKey: "3993", subtitleStreamID: 8 });
  await player.next("play");
  await postJson(baseUrl, "/api/plex/play", { ratingKey: "3993" });
  assert.equal((await player.next("play")).plex.activeSubtitleID, 8);
  // A slow earlier save cannot overwrite a later Off selection.
  let releaseMetadata;
  const delayed = new Promise((resolve) => {
    holdMetadata = (release) => { releaseMetadata = release; resolve(); };
  });
  const staleSave = select(8);
  await delayed;
  assert.equal((await select(null)).status, 200);
  releaseMetadata();
  assert.equal((await staleSave).status, 409);
  await postJson(baseUrl, "/api/plex/play", { ratingKey: "3993" });
  assert.equal((await player.next("play")).plex.activeSubtitleID, null);
});
