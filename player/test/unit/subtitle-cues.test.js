import test from "node:test";
import assert from "node:assert/strict";
import { buildCueEndPrefix, findActiveCues, parseVTT } from "../../src/subtitle-cues.js";

test("overlapping subtitle cues remain discoverable", () => {
  const cues = parseVTT(`WEBVTT

00:00:01.000 --> 00:00:10.000
长时间显示的标识

00:00:05.000 --> 00:00:06.000
中文对白
English dialogue

00:00:07.000 --> 00:00:08.000
Later cue
`);
  const track = { cues, cueEndPrefix: buildCueEndPrefix(cues) };

  assert.deepEqual(findActiveCues(track, 5.5).map((cue) => cue.text), [
    "长时间显示的标识",
    "中文对白\nEnglish dialogue",
  ]);
  assert.deepEqual(findActiveCues(track, 6.5).map((cue) => cue.text), ["长时间显示的标识"]);
  assert.deepEqual(findActiveCues(track, 10), []);
});

test("CRLF cues and timestamps without hours are parsed", () => {
  const cues = parseVTT("WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nFirst\r\n\r\n00:00:03.000 --> 00:00:04.000\r\nSecond\r\n");
  assert.deepEqual(cues.map((cue) => ({ start: cue.start, end: cue.end, text: cue.text })), [
    { start: 1, end: 2, text: "First" },
    { start: 3, end: 4, text: "Second" },
  ]);
});
