import assert from "node:assert/strict";
import test from "node:test";
import { requestJson, requestText } from "../../src/network.js";

test("GET retries a transient response and parses JSON", async () => {
  let calls = 0;
  const result = await requestJson("https://example.test/data", {}, {
    retryDelaysMs: [0],
    sleepFn: async () => {},
    fetchFn: async () => {
      calls += 1;
      return new Response(calls === 1 ? "busy" : JSON.stringify({ ok: true }), {
        status: calls === 1 ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.data, { ok: true });
});

test("POST does not retry by default", async () => {
  let calls = 0;
  const result = await requestText("https://example.test/action", { method: "POST" }, {
    fetchFn: async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 503);
});

test("timeout covers a stalled response body", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
  });
  await assert.rejects(
    requestText("https://example.test/stall", {}, {
      timeoutMs: 20,
      retries: 0,
      fetchFn: async () => new Response(body),
    }),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
});

test("external cancellation stops a pending request", async () => {
  const controller = new AbortController();
  const reason = new Error("route changed");
  const request = requestText("https://example.test/pending", { signal: controller.signal }, {
    timeoutMs: 5_000,
    retries: 2,
    fetchFn: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  controller.abort(reason);
  await assert.rejects(request, reason);
});

test("rejects an oversized body before buffering it", async () => {
  await assert.rejects(
    requestText("https://example.test/large", {}, {
      maxBytes: 4,
      retries: 0,
      fetchFn: async () => new Response("12345", { headers: { "Content-Length": "5" } }),
    }),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );
});
