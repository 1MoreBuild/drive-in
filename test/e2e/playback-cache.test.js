import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { HlsSegmentPrefetcher } from "../../player/src/engine/hls-segment-prefetcher.js";

test("rewinding reuses downloaded media instead of hitting the origin again", async (t) => {
  const requests = new Map();
  const origin = createServer((request, response) => {
    requests.set(request.url, (requests.get(request.url) || 0) + 1);
    if (request.url === "/playlist.m3u8") {
      response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      response.end("#EXTM3U\n#EXTINF:5,\n/0.m4s\n#EXTINF:5,\n/1.m4s\n");
      return;
    }
    response.setHeader("Content-Type", "video/mp4");
    response.end(`media:${request.url}`);
  });
  await new Promise((resolveListen) => origin.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => origin.close(resolveClose)));
  const baseUrl = `http://127.0.0.1:${origin.address().port}`;
  const prefetcher = new HlsSegmentPrefetcher({ baseUrl, maxConcurrent: 0, maxRetries: 0 });
  t.after(() => prefetcher.destroy());

  await prefetcher.fetch(`${baseUrl}/playlist.m3u8`);
  assert.equal(await (await prefetcher.fetch(`${baseUrl}/0.m4s`)).text(), "media:/0.m4s");
  assert.equal(await (await prefetcher.fetch(`${baseUrl}/1.m4s`)).text(), "media:/1.m4s");

  prefetcher.handleSeek(0);
  assert.equal(await (await prefetcher.fetch(`${baseUrl}/0.m4s`)).text(), "media:/0.m4s");
  assert.equal(requests.get("/0.m4s"), 1);
  assert.equal(requests.get("/1.m4s"), 1);
  assert.equal(prefetcher.getStats().cachedSegments, 2);
});
