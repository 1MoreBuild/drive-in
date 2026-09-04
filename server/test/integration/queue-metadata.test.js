import assert from "node:assert/strict";
import test from "node:test";

// Never touch the running server's queue database.
process.env.DRIVEIN_DB = ":memory:";
const { registerQueuePlaylistApi } = await import("../../queue-playlist-api.js");
const { clearQueue, listQueue, createPlaylist, getPlaylist } = await import("../../queue-store.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  clearQueue();
  const routes = new Map();
  const pending = new Map();
  let updates = 0;
  const app = Object.fromEntries(["get", "post", "patch", "delete"].map((method) => [
    method, (path, handler) => routes.set(`${method} ${path}`, handler),
  ]));
  registerQueuePlaylistApi(app, {
    resolveUrlMetadata: (url) => new Promise((resolve, reject) => pending.set(url, { resolve, reject })),
    broadcastQueue() { updates++; },
    broadcastPlaylists() { updates++; },
  });
  return {
    pending,
    get updates() { return updates; },
    async call(method, path, body, params = {}) {
      const response = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
      await routes.get(`${method} ${path}`)({ body, params }, response);
      return response;
    },
  };
}

test("slow metadata does not delay adding or reverse queue order", async () => {
  const h = harness();
  const a = "https://example.test/a";
  const b = "https://example.test/b";
  const first = await h.call("post", "/api/queue", { url: a });
  const second = await h.call("post", "/api/queue", { url: b });
  assert.equal(first.code, 201);
  assert.equal(second.code, 201);
  assert.deepEqual(listQueue().map((item) => item.url), [a, b]);
  h.pending.get(b).resolve({ title: "Second", thumbnail: "https://example.test/b.jpg", duration: 20 });
  await flush();
  h.pending.get(a).resolve({ title: "First", thumbnail: "https://example.test/a.jpg", duration: 10 });
  await flush();
  assert.deepEqual(listQueue().map((item) => [item.id, item.title]), [
    [first.data.item.id, "First"], [second.data.item.id, "Second"],
  ]);
});

test("clear and remove prevent pending metadata from resurrecting items", async () => {
  for (const action of ["clear", "remove"]) {
    const h = harness();
    const url = "https://example.test/slow";
    const added = await h.call("post", "/api/queue", { url });
    const removed = action === "clear"
      ? await h.call("delete", "/api/queue")
      : await h.call("delete", "/api/queue/:id", null, { id: added.data.item.id });
    assert.equal(removed.code, 200);
    const updates = h.updates;
    h.pending.get(url).resolve({ title: "Too late", duration: 10 });
    await flush();
    assert.deepEqual(listQueue(), []);
    assert.equal(h.updates, updates);
  }
});

test("metadata failure leaves the accepted item playable", async () => {
  const h = harness();
  const url = "https://example.test/offline";
  const added = await h.call("post", "/api/queue", { url });
  h.pending.get(url).reject(new Error("offline"));
  await flush();
  assert.equal(listQueue()[0].id, added.data.item.id);
  assert.equal(listQueue()[0].url, url);
});

test("invalid URL returns 400 without persisting or resolving it", async () => {
  const h = harness();
  const response = await h.call("post", "/api/queue", { url: "--version" });
  assert.equal(response.code, 400);
  assert.deepEqual(listQueue(), []);
  assert.equal(h.pending.size, 0);
});

test("playlist metadata completion cannot restore a removed item", async () => {
  const h = harness();
  const playlist = createPlaylist({ name: "Test" });
  const url = "https://example.test/playlist-item";
  const added = await h.call("post", "/api/playlists/:id/items", { url }, { id: playlist.id });
  assert.equal(added.code, 201);
  await h.call("delete", "/api/playlists/:id/items/:itemId", null, { id: playlist.id, itemId: added.data.item.id });
  h.pending.get(url).resolve({ title: "Too late", duration: 10 });
  await flush();
  assert.deepEqual(getPlaylist(playlist.id).items, []);
});
