import assert from "node:assert/strict";
import test from "node:test";
import { playlistItemsFromInfo } from "../../queue-playlist-api.js";

test("normalizes imported playlist entries without coupling to yt-dlp", () => {
  const result = playlistItemsFromInfo({
    title: "Road trip",
    extractor_key: "YoutubeTab",
    entries: [
      { id: "a", title: "First", duration: 12.9, thumbnails: [{ url: "small" }, { url: "large" }] },
      { id: "missing" },
    ],
  }, "https://example.test/list", (entry) => entry.id === "a" ? "https://example.test/watch/a" : null);
  assert.equal(result.title, "Road trip");
  assert.deepEqual(result.items, [{
    url: "https://example.test/watch/a",
    title: "First",
    thumbnail: "large",
    duration: 12,
    metadata: {
      importedFrom: "https://example.test/list",
      extractor: "YoutubeTab",
      playlistTitle: "Road trip",
    },
  }]);
});
