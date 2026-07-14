import assert from "node:assert/strict";
import test from "node:test";

import { requestPlexPlayback } from "../src/plex-preferences.js";

globalThis.location = new URL("https://drivein.test/");

test("Plex playback requests reject HTTP errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ error: "transcode failed" }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  ));

  await assert.rejects(
    requestPlexPlayback({ ratingKey: "42" }),
    /transcode failed/,
  );
});

test("Plex playback requests return successful JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ ok: true, title: "Movie" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ));

  assert.deepEqual(
    await requestPlexPlayback({ ratingKey: "42" }),
    { ok: true, title: "Movie" },
  );
});
