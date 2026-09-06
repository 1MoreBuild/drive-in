import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { AudioRingBuffer } from "../../src/engine/audio-ring-buffer.js";

test("audio EOF drains a partial worklet quantum without flagging an underrun", async () => {
  let Processor;
  vm.runInNewContext(readFileSync(new URL("../../src/engine/audio-worklet-processor.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class { port = { postMessage() {} }; },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  });
  const ring = new AudioRingBuffer({ capacityFrames: 256, channels: 1 });
  await ring.writeAudioBuffer({ length: 3, numberOfChannels: 1, getChannelData: () => new Float32Array([0.25, 0.5, 0.75]) });
  const processor = new Processor({ processorOptions: ring.processorOptions });
  const channel = new Float32Array(128);
  ring.setRunning(true);
  processor.process([], [[channel]]);
  assert.equal(ring.consumedFrames, 0); // Ordinary underflow still buffers.
  assert.equal(ring.underrunCount, 1);
  ring.markEnded();
  ring.setRunning(true);
  processor.process([], [[channel]]);
  assert.equal(ring.availableFrames, 0);
  assert.equal(ring.consumedFrames, 3);
  assert.deepEqual([...channel.slice(0, 4)], [0.25, 0.5, 0.75, 0]);
  processor.process([], [[channel]]);
  assert.equal(ring.consumedFrames, 3);
  assert.equal(ring.underrunCount, 1);
  ring.reset();
  ring.setRunning(true);
  processor.process([], [[channel]]);
  assert.equal(ring.needsBuffering, true); // A new seek is no longer at EOF.
});
