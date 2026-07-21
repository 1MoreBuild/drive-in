import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable } from "stream";
import { pipelineToResponse } from "../../response-pipeline.js";

test("response pipeline restores the response listener limit", async () => {
  const response = new PassThrough();
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.setMaxListeners(10);

  await pipelineToResponse(Readable.from(["drive", "-in"]), response);

  assert.equal(Buffer.concat(chunks).toString("utf8"), "drive-in");
  assert.equal(response.getMaxListeners(), 10);
});
