import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichQueueItemInput,
  playlistItemsFromInfo,
  queueMetadataFromInfo,
} from "../../queue-playlist-api.js";

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

test("normalizes URL metadata for queue cards", () => {
  assert.deepEqual(queueMetadataFromInfo({
    title: "Long interview",
    duration: 18951.9,
    thumbnails: [
      { url: "https://i.ytimg.com/small.jpg" },
      { url: "https://i.ytimg.com/maxresdefault.jpg" },
    ],
  }), {
    title: "Long interview",
    thumbnail: "/api/thumb?url=https%3A%2F%2Fi.ytimg.com%2Fmaxresdefault.jpg",
    duration: 18951,
  });
});

test("enriches a bare URL queue item", async () => {
  const item = await enrichQueueItemInput({ url: "https://example.test/watch/1" }, {
    resolveUrlMetadata: async () => ({
      title: "Resolved title",
      thumbnail: "https://example.test/thumb.jpg",
      duration: 42.8,
    }),
  });
  assert.deepEqual(item, {
    url: "https://example.test/watch/1",
    title: "Resolved title",
    thumbnail: "/api/thumb?url=https%3A%2F%2Fexample.test%2Fthumb.jpg",
    duration: 42,
  });
});

test("fills missing fields while preserving custom title and thumbnail", async () => {
  const resolver = { resolveUrlMetadata: async () => ({
    title: "Provider title", thumbnail: "https://example.test/provider.jpg", duration: 120,
  }) };
  const custom = await enrichQueueItemInput({
    url: "https://example.test/watch/1", title: "My title", duration: 50,
  }, resolver);
  assert.equal(custom.title, "My title");
  assert.equal(custom.duration, 50);
  assert.equal(custom.thumbnail, "/api/thumb?url=https%3A%2F%2Fexample.test%2Fprovider.jpg");
  const fallback = await enrichQueueItemInput({
    url: "https://example.test/watch/1", title: "https://example.test/watch/1",
    thumbnail: "/custom.jpg", duration: null,
  }, resolver);
  assert.equal(fallback.title, "Provider title");
  assert.equal(fallback.thumbnail, "/custom.jpg");
  assert.equal(fallback.duration, 120);
});

test("does not resolve already complete metadata", async () => {
  const input = { url: "https://example.test/1", title: "Custom", thumbnail: "/cover.jpg", duration: 50 };
  assert.equal(await enrichQueueItemInput(input, {
    resolveUrlMetadata: () => { assert.fail("must not resolve complete item"); },
  }), input);
});

test("rejects invalid URLs before invoking the resolver, even with a title", async () => {
  for (const url of ["--version", "--config-locations=/tmp/config", "file:///tmp/video", "ftp://example.test/a", "https://"]) {
    await assert.rejects(enrichQueueItemInput({ url, title: "Custom" }, {
      resolveUrlMetadata: () => { assert.fail("must not resolve invalid URL"); },
    }));
  }
});

test("keeps a bare URL playable when metadata enrichment fails", async () => {
  const warnings = [];
  const item = await enrichQueueItemInput({ url: "https://example.test/watch/1" }, {
    resolveUrlMetadata: async () => { throw new Error("offline"); },
    log: { warn: (...args) => warnings.push(args) },
  });
  assert.deepEqual(item, { url: "https://example.test/watch/1" });
  assert.equal(warnings.length, 1);
});
