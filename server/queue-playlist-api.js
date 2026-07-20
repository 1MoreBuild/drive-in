import {
  addPlaylistItem,
  addQueueItem,
  clearQueue,
  createPlaylist,
  deletePlaylist,
  enqueuePlaylist,
  getPlaylist,
  getQueueItem,
  listPlaylists,
  listQueue,
  removePlaylistItem,
  removeQueueItem,
  reorderPlaylistItems,
  reorderQueue,
  shiftQueueItem,
  updatePlaylist,
} from "./queue-store.js";

export function playlistItemsFromInfo(info, sourceUrl, entryUrlFor) {
  const entries = Array.isArray(info?.entries) ? info.entries : [];
  const items = entries.map((entry) => {
    const entryUrl = entryUrlFor(entry);
    if (!entryUrl) return null;
    const thumb = Array.isArray(entry.thumbnails) && entry.thumbnails.length
      ? entry.thumbnails[entry.thumbnails.length - 1]?.url
      : entry.thumbnail || null;
    return {
      url: entryUrl,
      title: entry.title || entry.fulltitle || entryUrl,
      thumbnail: thumb,
      duration: Number.isFinite(Number(entry.duration)) ? Math.floor(Number(entry.duration)) : null,
      metadata: {
        importedFrom: sourceUrl,
        extractor: entry.extractor_key || entry.ie_key || info.extractor_key || null,
        playlistTitle: info.title || null,
      },
    };
  }).filter(Boolean);
  return {
    title: info?.title || info?.playlist_title || "Imported Playlist",
    items,
  };
}

export function registerQueuePlaylistApi(app, {
  ytdlpFlatPlaylist,
  playlistEntryUrl,
  plexApi,
  hasPlex,
  playPlexNow,
  playUrlNow,
  broadcastQueue,
  broadcastPlaylists,
  onPlaybackError,
  log,
}) {
  async function buildQueueItemInput(body = {}) {
    const ratingKey = body.ratingKey ? String(body.ratingKey) : null;
    if (!ratingKey || body.title || !hasPlex) return body;
    try {
      const data = await plexApi(`/library/metadata/${ratingKey}`);
      const meta = data.MediaContainer.Metadata[0];
      const title = meta.grandparentTitle
        ? `${meta.grandparentTitle} S${meta.parentIndex}E${meta.index} — ${meta.title}`
        : meta.title;
      return {
        ...body,
        title,
        thumbnail: meta.art
          ? `/api/plex/thumb?path=${encodeURIComponent(meta.art)}`
          : meta.thumb ? `/api/plex/thumb?path=${encodeURIComponent(meta.thumb)}` : null,
        duration: meta.duration ? Math.round(meta.duration / 1000) : null,
      };
    } catch (error) {
      log.warn({ err: error?.message, ratingKey }, "Failed to enrich queued Plex item");
      return body;
    }
  }

  async function playlistItemsFromUrl(url) {
    const info = await ytdlpFlatPlaylist(url);
    return playlistItemsFromInfo(info, url, playlistEntryUrl);
  }

  async function playNextFromQueue(id = null) {
    const item = shiftQueueItem(id);
    if (!item) return null;
    broadcastQueue();
    try {
      const result = item.sourceType === "plex"
        ? await playPlexNow({ ratingKey: item.ratingKey })
        : await playUrlNow({ url: item.url });
      return { ok: true, item, result, queue: listQueue() };
    } catch (error) {
      addQueueItem(item, { playNext: true });
      broadcastQueue();
      throw error;
    }
  }

  app.get("/api/playlists", (_req, res) => res.json(listPlaylists()));
  app.post("/api/playlists", (req, res) => {
    try {
      const playlist = createPlaylist(req.body || {});
      broadcastPlaylists();
      res.status(201).json({ ok: true, playlist });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.post("/api/playlists/import-url", async (req, res) => {
    const { url, name, enqueue } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      const imported = await playlistItemsFromUrl(url);
      if (!imported.items.length) return res.status(400).json({ error: "No playlist entries found" });
      const playlist = createPlaylist({ name: name || imported.title, description: `Imported from ${url}` });
      for (const item of imported.items) addPlaylistItem(playlist.id, item);
      const hydrated = getPlaylist(playlist.id);
      broadcastPlaylists();
      if (enqueue) {
        enqueuePlaylist(playlist.id);
        broadcastQueue();
      }
      return res.status(201).json({ ok: true, playlist: hydrated, imported: imported.items.length, queue: listQueue() });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
  app.get("/api/playlists/:id", (req, res) => {
    const playlist = getPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: "playlist not found" });
    return res.json(playlist);
  });
  app.patch("/api/playlists/:id", (req, res) => {
    try {
      const playlist = updatePlaylist(req.params.id, req.body || {});
      if (!playlist) return res.status(404).json({ error: "playlist not found" });
      broadcastPlaylists();
      return res.json({ ok: true, playlist });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
  app.delete("/api/playlists/:id", (req, res) => {
    const playlist = deletePlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: "playlist not found" });
    broadcastPlaylists();
    return res.json({ ok: true, playlist });
  });
  app.post("/api/playlists/:id/items", async (req, res) => {
    if (!getPlaylist(req.params.id)) return res.status(404).json({ error: "playlist not found" });
    try {
      const item = addPlaylistItem(req.params.id, await buildQueueItemInput(req.body || {}));
      broadcastPlaylists();
      return res.status(201).json({ ok: true, item, playlist: getPlaylist(req.params.id) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
  app.delete("/api/playlists/:id/items/:itemId", (req, res) => {
    const item = removePlaylistItem(req.params.id, req.params.itemId);
    if (!item) return res.status(404).json({ error: "playlist item not found" });
    broadcastPlaylists();
    return res.json({ ok: true, item, playlist: getPlaylist(req.params.id) });
  });
  app.post("/api/playlists/:id/reorder", (req, res) => {
    if (!getPlaylist(req.params.id)) return res.status(404).json({ error: "playlist not found" });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!ids) return res.status(400).json({ error: "ids array required" });
    const playlist = reorderPlaylistItems(req.params.id, ids);
    broadcastPlaylists();
    return res.json({ ok: true, playlist });
  });
  app.post("/api/playlists/:id/enqueue", (req, res) => {
    if (!getPlaylist(req.params.id)) return res.status(404).json({ error: "playlist not found" });
    const added = enqueuePlaylist(req.params.id, { playNext: !!req.body?.playNext });
    broadcastQueue();
    return res.json({ ok: true, added, queue: listQueue() });
  });

  app.get("/api/queue", (_req, res) => res.json(listQueue()));
  app.post("/api/queue", async (req, res) => {
    try {
      const item = addQueueItem(await buildQueueItemInput(req.body), { playNext: !!req.body?.playNext });
      broadcastQueue();
      return res.status(201).json({ ok: true, item, queue: listQueue() });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
  app.post("/api/queue/reorder", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!ids) return res.status(400).json({ error: "ids array required" });
    const queue = reorderQueue(ids);
    broadcastQueue();
    return res.json({ ok: true, queue });
  });
  app.post("/api/queue/next", async (_req, res) => {
    try {
      const result = await playNextFromQueue();
      if (!result) return res.status(404).json({ error: "queue empty" });
      return res.json(result);
    } catch (error) {
      onPlaybackError(error);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });
  app.post("/api/queue/:id/play", async (req, res) => {
    if (!getQueueItem(req.params.id)) return res.status(404).json({ error: "queue item not found" });
    try {
      return res.json(await playNextFromQueue(req.params.id));
    } catch (error) {
      onPlaybackError(error);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });
  app.delete("/api/queue/:id", (req, res) => {
    const item = removeQueueItem(req.params.id);
    if (!item) return res.status(404).json({ error: "queue item not found" });
    broadcastQueue();
    return res.json({ ok: true, item, queue: listQueue() });
  });
  app.delete("/api/queue", (_req, res) => {
    const cleared = clearQueue();
    broadcastQueue();
    return res.json({ ok: true, cleared, queue: [] });
  });

  return { playNextFromQueue };
}
