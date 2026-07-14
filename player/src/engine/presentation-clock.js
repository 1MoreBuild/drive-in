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

