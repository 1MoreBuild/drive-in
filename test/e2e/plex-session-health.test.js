import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { startDriveInServer } from "./helpers.js";

test("Plex proxy turns missing sessions into immediate typed errors, not network stalls", async (t) => {
  let segmentRequests = 0;
  let mode = "expired";
  const plex = createServer((req, res) => {
    if (req.url === "/transcode/sessions") {
      if (mode === "unauthorized") { res.writeHead(401); res.end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ MediaContainer: mode === "expired" ? { size: 0 }
        : { size: 1, TranscodeSession: [{ key: "test-session" }] } }));
    } else {
      segmentRequests++;
      res.writeHead(mode === "alive" && segmentRequests > 1 ? 200 : 404);
      res.end(mode === "alive" && segmentRequests > 1 ? "segment" : "missing");
    }
  });
  await new Promise((resolve) => plex.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { plex.closeAllConnections(); plex.close(resolve); }));
  const { baseUrl } = await startDriveInServer(t, { PLEX_URL: `http://127.0.0.1:${plex.address().port}` });
  const path = "/api/plex/hls/session/test-session/base/360.ts";
  const started = performance.now();
  const expired = await fetch(baseUrl + path);
  assert.equal(expired.status, 410);
  assert.equal(expired.headers.get("x-drive-in-error-code"), "PLEX_SESSION_EXPIRED");
  assert.equal((await expired.json()).code, "PLEX_SESSION_EXPIRED");
  assert.ok(performance.now() - started < 2500, "dead sessions must not spend 15s retrying");
  assert.equal(segmentRequests, 1);

  const manifest = await fetch(baseUrl + path.replace("360.ts", "index.m3u8"));
  assert.equal(manifest.status, 410);
  assert.equal((await manifest.json()).code, "PLEX_SESSION_EXPIRED");

  await new Promise((resolve) => setTimeout(resolve, 300));
  mode = "alive";
  segmentRequests = 0;
  const pending = await fetch(baseUrl + path);
  assert.equal(pending.status, 200);
  assert.equal(await pending.text(), "segment");
  assert.equal(segmentRequests, 2);

  await new Promise((resolve) => setTimeout(resolve, 300));
  mode = "unauthorized";
  segmentRequests = 0;
  const unknown = await fetch(baseUrl + path);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("x-drive-in-error-code"), null);
  assert.equal(segmentRequests, 4);
});
