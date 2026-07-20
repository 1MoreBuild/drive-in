import assert from "node:assert/strict";
import test from "node:test";

import { getPlaybackEndReason } from "../src/engine/playback-end.js";

test("finishes when the advertised duration boundary is reached", () => {
  assert.equal(getPlaybackEndReason({
    duration: 433,
    mediaTime: 432.981,
    hasAudio: true,
    hasVideo: true,
    audioEnded: false,
    videoEnded: false,
    audioBufferedSeconds: 1,
    videoBufferedSeconds: 1,
  }), "duration-boundary");
});

test("live playback ignores the temporary playlist duration boundary", () => {
  assert.equal(getPlaybackEndReason({
    duration: 1784504669.105,
    mediaTime: 1784504669.105,
    hasAudio: true,
    hasVideo: true,
    audioEnded: false,
    videoEnded: false,
    audioBufferedSeconds: 3,
    videoBufferedSeconds: 0.2,
    ignoreDurationBoundary: true,
  }), null);
});

test("finishes a rounded duration once both decoded sources drain", () => {
  assert.equal(getPlaybackEndReason({
    duration: 433,
    mediaTime: 432.95691609977325,
    hasAudio: true,
    hasVideo: true,
    audioEnded: true,
    videoEnded: true,
    audioBufferedSeconds: 0.002,
    videoBufferedSeconds: 0,
  }), "sources-drained");
});

test("does not finish while either decoded source can still produce data", () => {
  assert.equal(getPlaybackEndReason({
    duration: 433,
    mediaTime: 432.95,
    hasAudio: true,
    hasVideo: true,
    audioEnded: true,
    videoEnded: false,
    audioBufferedSeconds: 0,
    videoBufferedSeconds: 0,
  }), null);
});

test("lets a decoded tail drain before finishing", () => {
  assert.equal(getPlaybackEndReason({
    duration: 433,
    mediaTime: 432.7,
    hasAudio: true,
    hasVideo: true,
    audioEnded: true,
    videoEnded: true,
    audioBufferedSeconds: 0,
    videoBufferedSeconds: 0.2,
  }), null);
});

test("does not treat an unloaded player with no tracks as drained", () => {
  assert.equal(getPlaybackEndReason({
    duration: 0,
    mediaTime: 0,
    hasAudio: false,
    hasVideo: false,
    audioEnded: false,
    videoEnded: false,
    audioBufferedSeconds: 0,
    videoBufferedSeconds: 0,
  }), null);
});
