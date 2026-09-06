const READ_INDEX = 0;
const AVAILABLE_FRAMES = 2;
const RUNNING = 3;
const CONSUMED_FRAMES = 4;
const UNDERRUN_COUNT = 5;
const NEEDS_BUFFERING = 6;
const ENDED = 7;

class DriveInAudioOutputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions;
    this.header = new Int32Array(config.headerBuffer);
    this.audio = new Float32Array(config.audioBuffer);
    this.capacityFrames = config.capacityFrames;
    this.channels = config.channels;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frameCount = output[0]?.length || 0;

    for (const channel of output) channel.fill(0);
    if (!frameCount || Atomics.load(this.header, RUNNING) !== 1) return true;

    const available = Atomics.load(this.header, AVAILABLE_FRAMES);
    if (available < frameCount && Atomics.load(this.header, ENDED) !== 1) {
      if (Atomics.compareExchange(this.header, NEEDS_BUFFERING, 0, 1) === 0) {
        Atomics.add(this.header, UNDERRUN_COUNT, 1);
        this.port.postMessage({ type: "underrun", availableFrames: available });
      }
      return true;
    }

    const consumed = Math.min(available, frameCount);
    let readIndex = Atomics.load(this.header, READ_INDEX);
    for (let frame = 0; frame < consumed; frame++) {
      const sourceOffset = ((readIndex + frame) % this.capacityFrames) * this.channels;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][frame] = this.audio[sourceOffset + Math.min(channel, this.channels - 1)];
      }
    }

    readIndex = (readIndex + consumed) % this.capacityFrames;
    Atomics.store(this.header, READ_INDEX, readIndex);
    Atomics.sub(this.header, AVAILABLE_FRAMES, consumed);
    Atomics.add(this.header, CONSUMED_FRAMES, consumed);
    return true;
  }
}

registerProcessor("drivein-audio-output-v1", DriveInAudioOutputProcessor);
