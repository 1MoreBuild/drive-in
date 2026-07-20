import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHistoryFile, saveHistoryFile } from "../history-store.js";

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
