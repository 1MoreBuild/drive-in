const READ_INDEX = 0;
const WRITE_INDEX = 1;
const AVAILABLE_FRAMES = 2;
const RUNNING = 3;
const CONSUMED_FRAMES = 4;
const UNDERRUN_COUNT = 5;
const NEEDS_BUFFERING = 6;
const HEADER_LENGTH = 8;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AudioRingBuffer {
  constructor({ capacityFrames, channels }) {
    this.capacityFrames = capacityFrames;
    this.channels = channels;
    this.headerBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * HEADER_LENGTH);
    this.audioBuffer = new SharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * capacityFrames * channels,
    );
    this.header = new Int32Array(this.headerBuffer);
    this.audio = new Float32Array(this.audioBuffer);
  }

  get processorOptions() {
    return {
      headerBuffer: this.headerBuffer,
      audioBuffer: this.audioBuffer,
      capacityFrames: this.capacityFrames,
      channels: this.channels,
    };
  }

  get availableFrames() {
    return Atomics.load(this.header, AVAILABLE_FRAMES);
  }

  get consumedFrames() {
    return Atomics.load(this.header, CONSUMED_FRAMES) >>> 0;
  }

  get underrunCount() {
    return Atomics.load(this.header, UNDERRUN_COUNT) >>> 0;
  }

  get needsBuffering() {
    return Atomics.load(this.header, NEEDS_BUFFERING) === 1;
  }

  setRunning(running) {
    Atomics.store(this.header, RUNNING, running ? 1 : 0);
    if (running) Atomics.store(this.header, NEEDS_BUFFERING, 0);
  }

  reset() {
    this.setRunning(false);
    Atomics.store(this.header, READ_INDEX, 0);
    Atomics.store(this.header, WRITE_INDEX, 0);
    Atomics.store(this.header, AVAILABLE_FRAMES, 0);
    Atomics.store(this.header, CONSUMED_FRAMES, 0);
    Atomics.store(this.header, NEEDS_BUFFERING, 0);
  }

  async writeAudioBuffer(buffer, { startFrame = 0, shouldContinue = () => true } = {}) {
    let sourceOffset = Math.max(0, startFrame);

    while (sourceOffset < buffer.length) {
      if (!shouldContinue()) return false;

      const freeFrames = this.capacityFrames - this.availableFrames;
      if (freeFrames <= 0) {
        await wait(10);
        continue;
      }

      const framesToWrite = Math.min(freeFrames, buffer.length - sourceOffset);
      this.writeChannels(buffer, sourceOffset, framesToWrite);
      sourceOffset += framesToWrite;
    }

    return true;
  }

  writeChannels(buffer, sourceOffset, frameCount) {
    let writeIndex = Atomics.load(this.header, WRITE_INDEX);
    const sourceChannels = Array.from(
      { length: buffer.numberOfChannels },
      (_, channel) => buffer.getChannelData(channel),
    );

    for (let frame = 0; frame < frameCount; frame++) {
      const destinationFrame = (writeIndex + frame) % this.capacityFrames;
      const destinationOffset = destinationFrame * this.channels;
      for (let channel = 0; channel < this.channels; channel++) {
        const source = sourceChannels[Math.min(channel, sourceChannels.length - 1)];
        this.audio[destinationOffset + channel] = source[sourceOffset + frame] || 0;
      }
    }

    writeIndex = (writeIndex + frameCount) % this.capacityFrames;
    Atomics.store(this.header, WRITE_INDEX, writeIndex);
    Atomics.add(this.header, AVAILABLE_FRAMES, frameCount);
  }
}

