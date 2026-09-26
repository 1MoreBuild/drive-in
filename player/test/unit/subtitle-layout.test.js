import assert from "node:assert/strict";
import test from "node:test";

import { buildCueEndPrefix } from "../../src/subtitle-cues.js";
import { activeSubtitleGroups, subtitleDisplayLines, subtitleLineLanguage, subtitlePictureBounds } from "../../src/subtitle-layout.js";

test("bilingual Plex IDs never become CSS language tags", () => {
  assert.equal(subtitleLineLanguage("他加了一条通风管", "plex:80803"), "zh-Hans");
  assert.equal(subtitleLineLanguage("He added an air-duct system.", "plex:80803"), "en");
  assert.equal(subtitleLineLanguage("日本語字幕", "ja"), "ja");
  assert.equal(subtitleLineLanguage("繁體字幕", "zh-Hant"), "zh-Hant");
});

test("bilingual dialogue does not expand two authored lines into four rows", () => {
  assert.deepEqual(subtitleDisplayLines("- He added an air-duct system... - Good.\n- 他加了通风管 - 好"), [
    "- He added an air-duct system... - Good.", "- 他加了通风管 - 好",
  ]);
  assert.deepEqual(subtitleDisplayLines("A well-known phrase - not another speaker."), ["A well-known phrase - not another speaker."]);
});

test("subtitle placement follows contained landscape and portrait pictures", () => {
  const wide = subtitlePictureBounds(773, 601, 1280, 536);
  assert.equal(wide.width, 773);
  assert.ok(Math.abs(wide.bottom - 138.65) < 1);
  const tall = subtitlePictureBounds(1000, 600, 600, 1000);
  assert.equal(tall.width, 360);
  assert.equal(tall.bottom, 0);
});

function track(lang, cues) {
  return { lang, cues, cueEndPrefix: buildCueEndPrefix(cues) };
}

test("groups every active line by subtitle language", () => {
  const groups = activeSubtitleGroups([
    track("zh-Hans", [
      { start: 0, end: 4, text: "第一行\n第二行" },
      { start: 1, end: 3, text: "重叠提示" },
    ]),
    track("en", [
      { start: 0, end: 4, text: "First line\nSecond line" },
    ]),
  ], 2);

  assert.deepEqual(groups, [
    { lang: "zh-Hans", lines: ["第一行", "第二行", "重叠提示"] },
    { lang: "en", lines: ["First line", "Second line"] },
  ]);
});

test("omits inactive tracks and blank subtitle lines", () => {
  const groups = activeSubtitleGroups([
    track("zh-Hans", [{ start: 0, end: 1, text: "已经结束" }]),
    track("en", [{ start: 1, end: 3, text: "  Active  \n  \n" }]),
  ], 2);

  assert.deepEqual(groups, [{ lang: "en", lines: ["Active"] }]);
});
