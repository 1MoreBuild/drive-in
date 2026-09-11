import assert from "node:assert/strict";
import test from "node:test";
import { createPlexSessionProbe, openPlexSegment, plexSessionId, sessionHealth } from "../../plex-session-health.js";

test("Plex inventory distinguishes expired, alive, and unknown sessions", () => {
  assert.equal(plexSessionId("/session/di-123/base/360.ts?foo=1"), "di-123");
  assert.equal(plexSessionId("/start.m3u8"), null);
  assert.equal(sessionHealth({ MediaContainer: { size: 0 } }, "old"), "expired");
  assert.equal(sessionHealth({ MediaContainer: { TranscodeSession: [{ key: "new" }] } }, "old"), "expired");
  assert.equal(sessionHealth({ MediaContainer: { TranscodeSession: [{ key: "/transcode/sessions/new" }] } }, "new"), "alive");
  for (const data of [null, {}, { MediaContainer: {} }, { MediaContainer: { TranscodeSession: [{}] } }]) {
    assert.equal(sessionHealth(data, "old"), "unknown");
  }
});

test("concurrent session probes share one bounded inventory request", async () => {
  let calls = 0;
  const probe = createPlexSessionProbe({ baseUrl: "http://plex", token: "fixture",
    fetchFn: async () => { calls++; return Response.json({ MediaContainer: { TranscodeSession: [{ key: "new" }] } }); },
  });
  assert.deepEqual(await Promise.all([probe("old"), probe("new"), probe("old")]), ["expired", "alive", "expired"]);
  assert.equal(calls, 1);
});

test("Plex authorization or malformed responses are not expiration", async () => {
  for (const response of [new Response("denied", { status: 401 }), new Response("invalid")]) {
    const probe = createPlexSessionProbe({ baseUrl: "http://plex", token: "fixture", fetchFn: async () => response });
    assert.equal(await probe("old"), "unknown");
  }
});

test("a snapshot started before session creation cannot mark the new session expired", async () => {
  let release;
  let calls = 0;
  const probe = createPlexSessionProbe({ baseUrl: "http://plex", token: "fixture",
    fetchFn: async () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => { release = resolve; });
      return Response.json({ MediaContainer: { TranscodeSession: [{ key: "new" }] } });
    },
  });
  const pending = probe("old");
  probe.invalidate();
  release(Response.json({ MediaContainer: { size: 0 } }));
  assert.equal(await pending, "unknown");
  assert.equal(await probe("new"), "alive");
  assert.equal(calls, 2);
});

function streams(statuses) {
  const state = { calls: 0, cleaned: 0 };
  state.openStream = async () => ({ response: new Response(null, { status: statuses[state.calls++] }),
    cleanup() { state.cleaned++; }, touch() {},
  });
  return state;
}

test("expired Plex segment returns typed 410 without retrying the stale URL", async () => {
  const mock = streams([404]);
  const result = await openPlexSegment("http://plex/old", { ...mock, session: "old", probe: async () => "expired" });
  assert.equal(result.response.status, 410);
  assert.equal(result.response.headers.get("X-Drive-In-Error-Code"), "PLEX_SESSION_EXPIRED");
  assert.equal((await result.response.json()).code, "PLEX_SESSION_EXPIRED");
  assert.equal(mock.calls, 1);
  assert.equal(mock.cleaned, 1);
});

test("live session can retry a not-yet-generated segment", async () => {
  const mock = streams([404, 200]);
  const result = await openPlexSegment("http://plex/new", { ...mock, retryDelaysMs: [0, 1], probe: async () => "alive" });
  assert.equal(result.response.status, 200);
  assert.equal(mock.calls, 2);
  assert.equal(mock.cleaned, 1);
});

test("unknown session gets bounded retries, not a false expired response", async () => {
  const mock = streams([404, 404]);
  const result = await openPlexSegment("http://plex/unknown", { ...mock, retryDelaysMs: [0, 1], probe: async () => "unknown" });
  assert.equal(result.response.status, 404);
  assert.equal(mock.calls, 2);
});

test("disconnect aborts retry wait instead of fetching more stale segments", async () => {
  const mock = streams([404]);
  const controller = new AbortController();
  await assert.rejects(openPlexSegment("http://plex/old", { ...mock, signal: controller.signal,
    probe: async () => { controller.abort(new Error("disconnected")); return "alive"; },
  }), /disconnected/);
  assert.equal(mock.calls, 1);
});

test("total header budget bounds a nonresponsive Plex request", async () => {
  await assert.rejects(openPlexSegment("http://plex/stalled", {
    budgetMs: 20, probe: async () => "unknown",
    openStream: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  }), /budget exceeded/);
});

test("header budget also bounds health checks but does not cap successful body transfers", async () => {
  const mock = streams([404]);
  await assert.rejects(openPlexSegment("http://plex/stalled-probe", {
    ...mock, budgetMs: 20, probe: () => new Promise(() => {}),
  }), /budget exceeded/);
  let bodySignal;
  await openPlexSegment("http://plex/slow-body", { budgetMs: 20,
    openStream: async (_url, { signal }) => {
      bodySignal = signal;
      return { response: new Response("body"), cleanup() {}, touch() {} };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(bodySignal.aborted, false);
});
