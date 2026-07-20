const MAX_AUDIO_OUTPUT_LATENCY_SECONDS = 0.5;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function estimateAudioOutputLatencySeconds(audioContext, now = performance.now()) {
  if (!audioContext) return 0;

  try {
    const timestamp = audioContext.getOutputTimestamp?.();
    const contextTime = Number(timestamp?.contextTime);
    const performanceTime = Number(timestamp?.performanceTime);
    const currentTime = Number(audioContext.currentTime);
    if (
      Number.isFinite(contextTime)
      && Number.isFinite(performanceTime)
      && Number.isFinite(currentTime)
    ) {
      const elapsed = Math.max(0, now - performanceTime) / 1000;
      const audibleContextTime = contextTime + elapsed;
      return Math.min(
        MAX_AUDIO_OUTPUT_LATENCY_SECONDS,
        Math.max(0, currentTime - audibleContextTime),
      );
    }
  } catch {
    // Older Chromium builds can expose the method without a usable timestamp.
  }

  return Math.min(
    MAX_AUDIO_OUTPUT_LATENCY_SECONDS,
    finiteNonNegative(audioContext.baseLatency) + finiteNonNegative(audioContext.outputLatency),
  );
}

export class PresentationClock {
  constructor() {
    this.audioRing = null;
    this.sampleRate = 0;
    this.baseMediaTime = 0;
    this.wallStartedAt = 0;
    this.wallElapsed = 0;
    this.running = false;
  }

  useAudioRing(audioRing, sampleRate) {
    this.audioRing = audioRing;
    this.sampleRate = sampleRate;
  }

  reset(mediaTime) {
    this.baseMediaTime = mediaTime;
    this.wallElapsed = 0;
    this.wallStartedAt = performance.now();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.wallStartedAt = performance.now();
  }

  stop() {
    if (!this.running) return;
    if (!this.audioRing) {
      this.wallElapsed += (performance.now() - this.wallStartedAt) / 1000;
    }
    this.running = false;
  }

  get currentTime() {
    if (this.audioRing && this.sampleRate > 0) {
      return this.baseMediaTime + this.audioRing.consumedFrames / this.sampleRate;
    }

    const activeElapsed = this.running
      ? (performance.now() - this.wallStartedAt) / 1000
      : 0;
    return this.baseMediaTime + this.wallElapsed + activeElapsed;
  }
}
