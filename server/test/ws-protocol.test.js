import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlayerState, normalizePlayerStatus } from "../ws-protocol.js";

test("player statuses are allowlisted and mapped to server states", () => {
  assert.equal(normalizePlayerStatus("playing"), "playing");
  assert.equal(normalizePlayerStatus("loading"), "resolving");
  assert.equal(normalizePlayerStatus("owned-by-attacker"), null);
});

test("player state drops extra fields and clamps invalid numbers", () => {
  const state = normalizePlayerState({
    currentTime: -100,
    duration: "90",
    isPlaying: "yes",
    isMuted: true,
    plexRatingKey: "x".repeat(200),
    viewport: {
      innerWidth: 999999,
      innerHeight: 900,
      visualViewport: { width: 1800, height: 900, scale: 1 },
      injected: "nope",
    },
    injected: "nope",
  });
  assert.equal(state.currentTime, 0);
  assert.equal(state.duration, 90);
  assert.equal(state.isPlaying, false);
  assert.equal(state.isMuted, true);
  assert.equal(state.plexRatingKey.length, 128);
  assert.equal(state.viewport.innerWidth, 20_000);
  assert.equal(state.viewport.visualViewport.width, 1800);
  assert.equal("injected" in state.viewport, false);
  assert.equal("injected" in state, false);
});
