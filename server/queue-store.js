import Database from "better-sqlite3";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DRIVEIN_DB || resolve(__dirname, "../.drive-in.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('url', 'plex')),
  url TEXT,
  rating_key TEXT,
  title TEXT NOT NULL,
  thumbnail TEXT,
  duration INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_items_position ON queue_items(position);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('url', 'plex')),
  url TEXT,
  rating_key TEXT,
  title TEXT NOT NULL,
  thumbnail TEXT,
  duration INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_position ON playlist_items(playlist_id, position);
`);

function sourceRowToItem(row) {
  if (!row) return null;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata || "{}"); } catch {}
  return {
    id: row.id,
    sourceType: row.source_type,
    url: row.url,
    ratingKey: row.rating_key,
    title: row.title,
    thumbnail: row.thumbnail,
    duration: row.duration,
    metadata,
    position: row.position,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

function playlistRowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    itemCount: row.item_count || 0,
    duration: row.duration || null,
    thumbnail: row.thumbnail || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeQueueInput(input = {}) {
  const ratingKey = input.ratingKey ? String(input.ratingKey) : null;
  const url = input.url ? String(input.url) : null;
  if (!ratingKey && !url) throw new Error("url or ratingKey required");
  const sourceType = ratingKey ? "plex" : "url";
  return {
    sourceType,
    url: sourceType === "url" ? url : null,
    ratingKey,
    title: String(input.title || (ratingKey ? `Plex ${ratingKey}` : url)),
    thumbnail: input.thumbnail || null,
    duration: Number.isFinite(Number(input.duration)) ? Math.floor(Number(input.duration)) : null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

function nextPosition({ playNext = false } = {}) {
  if (playNext) {
    const first = db.prepare("SELECT MIN(position) AS pos FROM queue_items").get().pos;
    return Number.isFinite(first) ? first - 1 : 1;
  }
  const last = db.prepare("SELECT MAX(position) AS pos FROM queue_items").get().pos;
  return Number.isFinite(last) ? last + 1 : 1;
}

export function listQueue() {
  return db.prepare("SELECT * FROM queue_items ORDER BY position ASC, added_at ASC").all().map(sourceRowToItem);
}

export function addQueueItem(input, options = {}) {
  const item = normalizeQueueInput(input);
  const now = Date.now();
  const id = `q_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO queue_items
      (id, source_type, url, rating_key, title, thumbnail, duration, metadata, position, added_at, updated_at)
    VALUES
      (@id, @sourceType, @url, @ratingKey, @title, @thumbnail, @duration, @metadata, @position, @addedAt, @updatedAt)
  `).run({
    id,
    ...item,
    metadata: JSON.stringify(item.metadata),
    position: nextPosition(options),
    addedAt: now,
    updatedAt: now,
  });
  normalizePositions();
  return getQueueItem(id);
}

export function getQueueItem(id) {
  return sourceRowToItem(db.prepare("SELECT * FROM queue_items WHERE id = ?").get(id));
}

export function removeQueueItem(id) {
  const item = getQueueItem(id);
  if (!item) return null;
  db.prepare("DELETE FROM queue_items WHERE id = ?").run(id);
  normalizePositions();
  return item;
}

export function shiftQueueItem(id = null) {
  const item = id
    ? getQueueItem(id)
    : sourceRowToItem(db.prepare("SELECT * FROM queue_items ORDER BY position ASC, added_at ASC LIMIT 1").get());
  if (!item) return null;
  db.prepare("DELETE FROM queue_items WHERE id = ?").run(item.id);
  normalizePositions();
  return item;
}

export function clearQueue() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM queue_items").get().count;
  db.prepare("DELETE FROM queue_items").run();
  return count;
}

export function reorderQueue(ids = []) {
  const tx = db.transaction((orderedIds) => {
    let position = 1;
    for (const id of orderedIds) {
      db.prepare("UPDATE queue_items SET position = ?, updated_at = ? WHERE id = ?").run(position++, Date.now(), id);
    }
    normalizePositions();
  });
  tx(ids.map(String));
  return listQueue();
}

export function normalizePositions() {
  const rows = db.prepare("SELECT id FROM queue_items ORDER BY position ASC, added_at ASC").all();
  const update = db.prepare("UPDATE queue_items SET position = ? WHERE id = ?");
  const tx = db.transaction(() => {
    rows.forEach((row, index) => update.run(index + 1, row.id));
  });
  tx();
}

function nextPlaylistItemPosition(playlistId) {
  const last = db.prepare("SELECT MAX(position) AS pos FROM playlist_items WHERE playlist_id = ?").get(playlistId).pos;
  return Number.isFinite(last) ? last + 1 : 1;
}

function normalizePlaylistItemPositions(playlistId) {
  const rows = db.prepare("SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC, added_at ASC").all(playlistId);
  const update = db.prepare("UPDATE playlist_items SET position = ? WHERE id = ?");
  const tx = db.transaction(() => {
    rows.forEach((row, index) => update.run(index + 1, row.id));
  });
  tx();
}

function touchPlaylist(playlistId) {
  db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(Date.now(), playlistId);
}

export function listPlaylists() {
  return db.prepare(`
    SELECT
      p.*,
      COUNT(i.id) AS item_count,
      SUM(i.duration) AS duration,
      (
        SELECT thumbnail FROM playlist_items
        WHERE playlist_id = p.id AND thumbnail IS NOT NULL AND thumbnail != ''
        ORDER BY position ASC, added_at ASC
        LIMIT 1
      ) AS thumbnail
    FROM playlists p
    LEFT JOIN playlist_items i ON i.playlist_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC, p.created_at DESC
  `).all().map(playlistRowToItem);
}

export function createPlaylist({ name, description = null } = {}) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("name required");
  const now = Date.now();
  const id = `pl_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO playlists (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, trimmed, description ? String(description) : null, now, now);
  return getPlaylist(id);
}

export function getPlaylist(id) {
  const playlist = playlistRowToItem(db.prepare(`
    SELECT
      p.*,
      COUNT(i.id) AS item_count,
      SUM(i.duration) AS duration,
      (
        SELECT thumbnail FROM playlist_items
        WHERE playlist_id = p.id AND thumbnail IS NOT NULL AND thumbnail != ''
        ORDER BY position ASC, added_at ASC
        LIMIT 1
      ) AS thumbnail
    FROM playlists p
    LEFT JOIN playlist_items i ON i.playlist_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `).get(id));
  if (!playlist) return null;
  return { ...playlist, items: listPlaylistItems(id) };
}

export function updatePlaylist(id, patch = {}) {
  const existing = getPlaylist(id);
  if (!existing) return null;
  const name = patch.name !== undefined ? String(patch.name).trim() : existing.name;
  if (!name) throw new Error("name required");
  const description = patch.description !== undefined
    ? (patch.description ? String(patch.description) : null)
    : existing.description;
  db.prepare("UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, Date.now(), id);
  return getPlaylist(id);
}

export function deletePlaylist(id) {
  const existing = getPlaylist(id);
  if (!existing) return null;
  db.prepare("DELETE FROM playlists WHERE id = ?").run(id);
  return existing;
}

export function listPlaylistItems(playlistId) {
  return db.prepare(`
    SELECT * FROM playlist_items
    WHERE playlist_id = ?
    ORDER BY position ASC, added_at ASC
  `).all(playlistId).map(sourceRowToItem);
}

export function addPlaylistItem(playlistId, input) {
  if (!db.prepare("SELECT id FROM playlists WHERE id = ?").get(playlistId)) {
    throw new Error("playlist not found");
  }
  const item = normalizeQueueInput(input);
  const now = Date.now();
  const id = `pi_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO playlist_items
      (id, playlist_id, source_type, url, rating_key, title, thumbnail, duration, metadata, position, added_at, updated_at)
    VALUES
      (@id, @playlistId, @sourceType, @url, @ratingKey, @title, @thumbnail, @duration, @metadata, @position, @addedAt, @updatedAt)
  `).run({
    id,
    playlistId,
    ...item,
    metadata: JSON.stringify(item.metadata),
    position: nextPlaylistItemPosition(playlistId),
    addedAt: now,
    updatedAt: now,
  });
  normalizePlaylistItemPositions(playlistId);
  touchPlaylist(playlistId);
  return listPlaylistItems(playlistId).find((row) => row.id === id);
}

export function removePlaylistItem(playlistId, itemId) {
  const item = sourceRowToItem(db.prepare("SELECT * FROM playlist_items WHERE playlist_id = ? AND id = ?").get(playlistId, itemId));
  if (!item) return null;
  db.prepare("DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?").run(playlistId, itemId);
  normalizePlaylistItemPositions(playlistId);
  touchPlaylist(playlistId);
  return item;
}

export function reorderPlaylistItems(playlistId, ids = []) {
  const tx = db.transaction((orderedIds) => {
    let position = 1;
    for (const id of orderedIds) {
      db.prepare("UPDATE playlist_items SET position = ?, updated_at = ? WHERE playlist_id = ? AND id = ?")
        .run(position++, Date.now(), playlistId, id);
    }
    normalizePlaylistItemPositions(playlistId);
    touchPlaylist(playlistId);
  });
  tx(ids.map(String));
  return getPlaylist(playlistId);
}

export function enqueuePlaylist(playlistId, { playNext = false } = {}) {
  const items = listPlaylistItems(playlistId);
  const added = [];
  for (const item of (playNext ? items.slice().reverse() : items)) {
    added.push(addQueueItem(item, { playNext }));
  }
  return playNext ? added.reverse() : added;
}
