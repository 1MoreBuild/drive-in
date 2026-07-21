import test from "node:test";
import assert from "node:assert/strict";
import {
  expectedPlayerState,
  normalizePlayerConnectionId,
  normalizePlayerState,
  normalizePlayerStatus,
  playerConnectionDecision,
} from "../../ws-protocol.js";

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
    playbackIntent: "playing",
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
  assert.equal(state.playbackIntent, "playing");
  assert.equal(state.isMuted, true);
  assert.equal(state.plexRatingKey.length, 128);
  assert.equal(state.viewport.innerWidth, 20_000);
  assert.equal(state.viewport.visualViewport.width, 1800);
  assert.equal("injected" in state.viewport, false);
  assert.equal("injected" in state, false);
});

test("player intent remains distinct from a transient buffering state", () => {
  const state = normalizePlayerState({
    isPlaying: false,
    playbackIntent: "playing",
  });
  assert.equal(state.isPlaying, false);
  assert.equal(state.playbackIntent, "playing");
});

test("a play command updates the expected resume position before client telemetry arrives", () => {
  const state = expectedPlayerState({ viewport: { innerWidth: 1920 } }, {
    currentTime: 397.6,
    duration: 815,
    autoplay: true,
  });
  assert.equal(state.currentTime, 397.6);
  assert.equal(state.duration, 815);
  assert.equal(state.isPlaying, false);
  assert.equal(state.playbackIntent, "playing");
  assert.deepEqual(state.viewport, { innerWidth: 1920 });
  assert.ok(state.updatedAt > 0);
});

test("player connection ids are bounded opaque values", () => {
  assert.equal(normalizePlayerConnectionId("tesla-player_123"), "tesla-player_123");
  assert.equal(normalizePlayerConnectionId("short"), null);
  assert.equal(normalizePlayerConnectionId("bad/id/value"), null);
  assert.equal(normalizePlayerConnectionId("x".repeat(129)), null);
});

test("a healthy player keeps its lease while the same tab can reconnect", () => {
  assert.equal(playerConnectionDecision({ currentOpen: false }), "accept");
  assert.equal(playerConnectionDecision({
    currentOpen: true,
    currentAlive: true,
    currentId: "tesla-player_123",
    nextId: "other-player_123",
  }), "reject");
  assert.equal(playerConnectionDecision({
    currentOpen: true,
    currentAlive: true,
    currentId: "tesla-player_123",
    nextId: "tesla-player_123",
  }), "replace");
  assert.equal(playerConnectionDecision({
    currentOpen: true,
    currentAlive: false,
    currentId: "tesla-player_123",
    nextId: "other-player_123",
  }), "replace");
});
