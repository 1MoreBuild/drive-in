import assert from "node:assert/strict";
import test from "node:test";
import { LatestOperation } from "../../src/latest-operation.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("a newer operation supersedes an active operation before it publishes state", async () => {
  const operations = new LatestOperation();
  const cleanup = deferred();
  const published = [];

  const first = operations.run(async ({ isCurrent }) => {
    await cleanup.promise;
    if (!isCurrent()) return false;
    published.push("first");
    return true;
  });
  const second = operations.run(async ({ isCurrent }) => {
    if (!isCurrent()) return false;
    published.push("second");
    return true;
  });

  cleanup.resolve();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(published, ["second"]);
});

test("a failed operation does not poison the next operation", async () => {
  const operations = new LatestOperation();
  await assert.rejects(operations.run(async () => {
    throw new Error("failed cleanup");
  }), /failed cleanup/);

  assert.equal(await operations.run(async () => true), true);
});

test("invalidate prevents a queued operation from running", async () => {
  const operations = new LatestOperation();
  let ran = false;
  const operation = operations.run(async () => {
    ran = true;
    return true;
  });
  operations.invalidate();

  assert.equal(await operation, false);
  assert.equal(ran, false);
});
