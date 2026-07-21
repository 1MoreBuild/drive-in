import assert from "node:assert/strict";
import test from "node:test";

import { plexPlaybackRequest, requestPlexPlayback } from "../../src/plex-preferences.js";

const origin = "https://drivein.test";

test("Plex playback requests reject HTTP errors", async () => {
  const fetchFn = async () => new Response(
    JSON.stringify({ error: "transcode failed" }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    requestPlexPlayback({ ratingKey: "42" }, { origin, fetchFn }),
    /transcode failed/,
  );
});

test("Plex playback requests return successful JSON", async () => {
  const fetchFn = async () => new Response(
    JSON.stringify({ ok: true, title: "Movie" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  assert.deepEqual(
    await requestPlexPlayback({ ratingKey: "42" }, { origin, fetchFn }),
    { ok: true, title: "Movie" },
  );
});

test("fixed-quality Plex requests include language choices but no obsolete throughput hint", () => {
  const values = new Map([
    ["preferred-sub-langs", JSON.stringify(["zh", "en"])],
    ["preferred-audio-lang", "ja"],
  ]);
  const payload = plexPlaybackRequest("42", { autoplay: true }, {
    storage: { getItem: (key) => values.get(key) || null },
  });

  assert.deepEqual(payload, {
    ratingKey: "42",
    autoplay: true,
    preferredSubtitleLanguages: ["zh", "en"],
    preferredAudioLanguage: "ja",
  });
  assert.equal("estimatedThroughputKbps" in payload, false);
});
