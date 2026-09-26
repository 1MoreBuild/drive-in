import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubtitlePreferences } from "../../subtitle-preferences.js";

test("subtitle choices survive service restart, follow languages, and preserve explicit Off", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "drive-in-subtitle-prefs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "prefs.sqlite");
  const selected = { id: 80803, languageCode: "zho", title: "中文", delivery: "external" };
  let store = new SubtitlePreferences(path);
  assert.equal(store.select("plex:3993", [selected]), null);
  store.save("plex:3993", [selected]);
  store.close();
  store = new SubtitlePreferences(path);
  assert.deepEqual(store.select("plex:3993", [selected]), [selected]);
  const newText = { id: 20, languageCode: "zho", delivery: "external" };
  const image = { id: 19, languageCode: "zho", delivery: "burn" };
  assert.deepEqual(store.select("plex:another", [image, newText]), [newText]);
  assert.deepEqual(store.select("https://youtube.com/watch?v=test", [{ lang: "en" }, { lang: "zh-Hans" }]), [{ lang: "zh-Hans" }]);
  store.save("plex:3993", []);
  store.close();
  store = new SubtitlePreferences(path);
  assert.deepEqual(store.select("plex:3993", [selected]), []);
  assert.deepEqual(store.select("plex:new", [selected]), []);
  store.close();
});

test("a replaced Plex stream falls back by language rather than a stale ID", () => {
  const store = new SubtitlePreferences(":memory:");
  store.save("plex:1", [{ id: 2, languageCode: "eng", delivery: "external" }]);
  const replacement = { id: 3, languageCode: "eng", delivery: "external" };
  assert.deepEqual(store.select("plex:1", [replacement]), [replacement]);
  store.close();
});
