import assert from "node:assert/strict";
import test from "node:test";

import {
  connectPlayer,
  postJson,
  startDriveInServer,
  waitFor,
} from "./helpers.js";

test("playback survives a player reconnect with position and intent intact", async (t) => {
  const { baseUrl } = await startDriveInServer(t);
  const playerPage = await fetch(baseUrl);
  assert.equal(playerPage.status, 200);
  assert.equal(playerPage.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(playerPage.headers.get("cross-origin-embedder-policy"), "credentialless");
  assert.match(await playerPage.text(), /Drive-In/i);

  const firstPlayer = await connectPlayer(baseUrl);
  t.after(() => firstPlayer.close());

  const accepted = await firstPlayer.next("playerAccepted");
  assert.equal(accepted.playbackAvailable, false);

  const playResponse = await postJson(baseUrl, "/api/play", {
    url: "https://media.test/movie.mp4",
    startTime: 397,
    autoplay: true,
  });
  assert.equal(playResponse.response.status, 200);

  const play = await firstPlayer.next("play");
  assert.equal(play.sourceUrl, "https://media.test/movie.mp4");
  assert.equal(play.startTime, 397);
  assert.equal(play.autoplay, true);
  assert.equal(play.mediaSource.type, "mp4");
  assert.match(play.url, /^\/api\/proxy\?id=/);

  firstPlayer.socket.send(JSON.stringify({
    type: "playerState",
    currentTime: 412.5,
    duration: 815,
    isPlaying: true,
    playbackIntent: "playing",
    isMuted: false,
  }));
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.player.currentTime === 412.5 ? status : null;
  }, "player progress persistence");

  await firstPlayer.close();
  const resumedPlayer = await connectPlayer(baseUrl);
  t.after(() => resumedPlayer.close());
  const resumed = await resumedPlayer.next("playerAccepted");
  assert.equal(resumed.playbackAvailable, true);
  assert.deepEqual(resumed.playbackSnapshot, {
    currentTime: 412.5,
    duration: 815,
    isPlaying: true,
    playbackIntent: "playing",
    updatedAt: resumed.playbackSnapshot.updatedAt,
  });
  assert.ok(resumed.playbackSnapshot.updatedAt > 0);

  const pauseResponse = await postJson(baseUrl, "/api/control", { action: "pause" });
  assert.equal(pauseResponse.response.status, 200);
  assert.equal((await resumedPlayer.next("pause")).type, "pause");
  assert.equal(pauseResponse.body.status, "paused");
});
