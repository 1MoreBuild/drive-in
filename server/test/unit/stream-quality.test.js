import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFormatSelector,
  targetHeightForViewport,
} from "../../stream-quality.js";

test("windowed Tesla viewport selects 720p", () => {
  assert.equal(targetHeightForViewport({
    innerWidth: 1180,
    innerHeight: 919,
    visualViewport: { width: 1180, height: 919 },
  }), 720);
});

test("fullscreen viewport stays at fixed 720p", () => {
  assert.equal(targetHeightForViewport({
    innerWidth: 1920,
    innerHeight: 1080,
    visualViewport: { width: 1920, height: 1080 },
  }), 720);
});

test("format selector prefers 720p60 before 1080p30 and 720p30 fallbacks", () => {
  const selector = buildFormatSelector({ targetHeight: 720, maxVideoKbps: 4800 });
  const choices = selector.split("/");
  const sixtyFps = choices.findIndex((choice) => (
    choice.includes("[height<=720]") && choice.includes("[fps>=50]")
  ));
  const fullHdThirtyFps = choices.findIndex((choice) => (
    choice.includes("[height<=1080]") && choice.includes("[fps<50]")
  ));
  const fallback720 = choices.findIndex((choice) => choice === "b*[height<=720]");
  assert.ok(sixtyFps >= 0);
  assert.ok(fullHdThirtyFps > sixtyFps);
  assert.ok(fallback720 > fullHdThirtyFps);
});
