import assert from "node:assert/strict";
import test from "node:test";
import { metadataArgs } from "../../url-metadata.js";

test("passes a validated URL as a positional yt-dlp argument", () => {
  const url = "https://example.test/watch?v=1&title=--version";
  const args = metadataArgs(url, ["--cookies-from-browser", "chrome"]);
  assert.deepEqual(args.slice(0, 2), ["--cookies-from-browser", "chrome"]);
  assert.deepEqual(args.slice(-2), ["--", url]);
  for (const invalid of ["--version", "--config-locations=/tmp/config", "file:///etc/hosts", "javascript:alert(1)", {}, null]) {
    assert.throws(() => metadataArgs(invalid));
  }
});
