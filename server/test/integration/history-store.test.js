import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isEphemeralMediaUrl,
  loadHistoryFile,
  sanitizeHistoryEntries,
  saveHistoryFile,
} from "../../history-store.js";

test("history saves atomically without leaving temporary files", () => {
  const dir = mkdtempSync(join(tmpdir(), "drivein-history-"));
  const path = join(dir, "history.json");
  const history = [{ title: "Example", progress: 42 }];
  saveHistoryFile(path, history);
  assert.deepEqual(loadHistoryFile(path), history);
  assert.deepEqual(readdirSync(dir), ["history.json"]);
  assert.match(readFileSync(path, "utf8"), /Example/);
});

test("corrupt history is preserved before returning an empty store", () => {
  const dir = mkdtempSync(join(tmpdir(), "drivein-history-"));
  const path = join(dir, "history.json");
  writeFileSync(path, "{broken");
  let backupPath;
  assert.deepEqual(loadHistoryFile(path, { onCorrupt: (_error, backup) => { backupPath = backup; } }), []);
  assert.equal(readFileSync(backupPath, "utf8"), "{broken");
});

test("filters expiring CDN URLs from play history", () => {
  assert.equal(isEphemeralMediaUrl("https://rr1.googlevideo.com/videoplayback?expire=1"), true);
  assert.equal(isEphemeralMediaUrl("https://www.youtube.com/watch?v=abc"), false);
  assert.deepEqual(sanitizeHistoryEntries([
    { title: "Temporary", url: "https://rr1.googlevideo.com/videoplayback?expire=1" },
    { title: "Canonical", url: "https://www.youtube.com/watch?v=abc" },
    { title: "Plex", url: null, plex: { ratingKey: "1" } },
  ]), [
    { title: "Canonical", url: "https://www.youtube.com/watch?v=abc" },
    { title: "Plex", url: null, plex: { ratingKey: "1" } },
  ]);
});
