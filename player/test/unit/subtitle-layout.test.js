import assert from "node:assert/strict";
import test from "node:test";

import { buildCueEndPrefix } from "../../src/subtitle-cues.js";
import { activeSubtitleGroups } from "../../src/subtitle-layout.js";

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
