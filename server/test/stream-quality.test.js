import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFormatSelector,
  targetHeightForViewport,
} from "../stream-quality.js";

test("windowed Tesla viewport selects 720p", () => {
  assert.equal(targetHeightForViewport({
    innerWidth: 1180,
    innerHeight: 919,
    visualViewport: { width: 1180, height: 919 },
  }), 720);
});

test("fullscreen viewport selects 1080p", () => {
  assert.equal(targetHeightForViewport({
    innerWidth: 1920,
    innerHeight: 1080,
    visualViewport: { width: 1920, height: 1080 },
  }), 1080);
});

test("format selector prefers 60fps before same-height fallback", () => {
  const selector = buildFormatSelector({ targetHeight: 720, maxVideoKbps: 4800 });
  const sixtyFps = selector.indexOf("[height<=720][tbr<=4800][fps>=50]");
  const fallback = selector.indexOf("[height<=720][tbr<=4800]+ba");
  assert.ok(sixtyFps >= 0);
  assert.ok(fallback > sixtyFps);
  assert.equal(selector.includes("height<=1080"), false);
});
