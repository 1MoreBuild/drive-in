import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSubtitles,
  hasEnglishAndChineseSubtitles,
  isYouTubeUrl,
  mergeSubtitles,
} from "../../ytdlp-subtitles.js";

const vtt = (url, name) => [{ ext: "vtt", url, name }];

test("extracts YouTube automatic captions with regional language codes", () => {
  const subtitles = extractSubtitles({
    automatic_captions: {
      en: vtt("https://example.com/en.vtt", "English"),
      "en-orig": vtt("https://example.com/en-orig.vtt", "English (Original)"),
      "zh-Hans": vtt("https://example.com/zh-Hans.vtt", "Chinese (Simplified)"),
      "zh-Hant": vtt("https://example.com/zh-Hant.vtt", "Chinese (Traditional)"),
    },
  });

  assert.deepEqual(subtitles.map((subtitle) => subtitle.lang), [
    "en",
    "en-orig",
    "zh-Hans",
    "zh-Hant",
  ]);
  assert.equal(subtitles.every((subtitle) => subtitle.auto), true);
  assert.equal(hasEnglishAndChineseSubtitles(subtitles), true);
});

test("keeps manual subtitles ahead of automatic fallbacks", () => {
  const subtitles = extractSubtitles({
    subtitles: {
      en: vtt("https://example.com/manual.vtt", "English"),
    },
    automatic_captions: {
      en: vtt("https://example.com/auto.vtt", "English"),
    },
  });

  assert.deepEqual(subtitles.map((subtitle) => subtitle.lang), ["en", "en-auto"]);
  assert.equal(subtitles[0].auto, false);
  assert.equal(subtitles[1].auto, true);
});

test("merges public subtitle metadata without replacing authenticated results", () => {
  const primary = [{ lang: "en", url: "manual" }];
  const fallback = [
    { lang: "en", url: "automatic" },
    { lang: "zh-Hans", url: "translated" },
  ];

  assert.deepEqual(mergeSubtitles(primary, fallback), [
    { lang: "en", url: "manual" },
    { lang: "zh-Hans", url: "translated" },
  ]);
});

test("recognizes YouTube watch and short URLs only", () => {
  assert.equal(isYouTubeUrl("https://m.youtube.com/watch?v=abc"), true);
  assert.equal(isYouTubeUrl("https://youtu.be/abc"), true);
  assert.equal(isYouTubeUrl("https://example.com/youtube.com/watch"), false);
  assert.equal(isYouTubeUrl("not a URL"), false);
});
