import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchTextWithRetry, fetchWithRetry, openUpstreamStream } from "../../upstream-fetch.js";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const quietLogger = { warn() {} };

test("retries a transient upstream response", async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests += 1;
    res.writeHead(requests === 1 ? 503 : 200);
    res.end(requests === 1 ? "busy" : "ok");
  }, async (url) => {
    const response = await fetchWithRetry(url, {}, {
      retries: 1,
      retryDelaysMs: [0],
      logger: quietLogger,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  });
  assert.equal(requests, 2);
});

test("bounds an upstream that never sends response headers", async () => {
  await withServer(() => {}, async (url) => {
    await assert.rejects(
      fetchWithRetry(url, {}, {
        retries: 0,
        responseTimeoutMs: 20,
        logger: quietLogger,
      }),
      (error) => error.code === "UPSTREAM_RESPONSE_TIMEOUT",
    );
  });
});

test("bounds an upstream body that stops making progress", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("partial");
  }, async (url) => {
    await assert.rejects(
      fetchTextWithRetry(url, {}, {
        retries: 0,
        timeoutMs: 25,
        logger: quietLogger,
      }),
      (error) => error.code === "UPSTREAM_BODY_TIMEOUT",
    );
  });
});

test("external cancellation wins over retry", async () => {
  const controller = new AbortController();
  const reason = new Error("request closed");
  await withServer(() => {}, async (url) => {
    const request = fetchWithRetry(url, { signal: controller.signal }, {
      retries: 3,
      responseTimeoutMs: 5_000,
      logger: quietLogger,
    });
    controller.abort(reason);
    await assert.rejects(request, reason);
  });
});

test("stream inactivity aborts a response after its headers arrive", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.write("first");
  }, async (url) => {
    const opened = await openUpstreamStream(url, {}, {
      responseTimeoutMs: 100,
      inactivityTimeoutMs: 20,
      label: "test-stream",
    });
    try {
      const reader = opened.response.body.getReader();
      const first = await reader.read();
      assert.equal(Buffer.from(first.value).toString(), "first");
      await assert.rejects(
        reader.read(),
        (error) => error?.code === "UPSTREAM_INACTIVITY_TIMEOUT"
          || error?.cause?.code === "UPSTREAM_INACTIVITY_TIMEOUT",
      );
    } finally {
      opened.cleanup();
    }
  });
});
