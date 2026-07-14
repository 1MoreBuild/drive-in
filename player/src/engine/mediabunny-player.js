import {
  AudioBufferSink,
  CanvasSink,
  HLS_FORMATS,
  Input,
  UrlSource,
} from "mediabunny";
import { AudioRingBuffer } from "./audio-ring-buffer.js";
import { PresentationClock } from "./presentation-clock.js";

const AUDIO_CAPACITY_SECONDS = 3;
const AUDIO_START_SECONDS = 0.75;
const AUDIO_REBUFFER_SECONDS = 0.15;
const VIDEO_QUEUE_CAPACITY = 12;
const VIDEO_START_SECONDS = 0.25;
const VIDEO_REBUFFER_SECONDS = 0.08;
const TIME_EVENT_INTERVAL_MS = 250;
// Large enough to keep a 1080p video queue fed across Cloudflare, while still
// preventing UrlSource's open-ended ranges from extending to multi-GB EOFs.
const NETWORK_RANGE_CHUNK_BYTES = 2 * 1024 * 1024;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function boundedRangeFetch(input, init = {}) {
  const headers = new Headers(init.headers);
  const range = headers.get("Range");
  const openRange = range?.match(/^bytes=(\d+)-$/i);
  if (openRange) {
    const start = Number(openRange[1]);
    if (Number.isSafeInteger(start)) {
      headers.set("Range", `bytes=${start}-${start + NETWORK_RANGE_CHUNK_BYTES - 1}`);
    }
  }
  return globalThis.fetch(input, { ...init, headers });
}

export class MediabunnyPlayer {
  constructor({
    container,
    onStateChange = () => {},
    onTime = () => {},
    onFirstVideo = () => {},
    onEnded = () => {},
    onError = () => {},
    faultInjection = null,
  }) {
    this.container = container;
    this.onStateChange = onStateChange;
    this.onTime = onTime;
    this.onFirstVideo = onFirstVideo;
    this.onEnded = onEnded;
    this.onError = onError;
    this.faultInjection = faultInjection;

    this.input = null;
    this.inputs = [];
    this.videoTrack = null;
    this.audioTrack = null;
    this.videoSink = null;
    this.audioSink = null;
    this.videoIterator = null;
    this.audioIterator = null;
    this.audioContext = null;
    this.audioRing = null;
    this.audioNode = null;
    this.gainNode = null;
    this.compressorNode = null;
    this.clock = new PresentationClock();

    this.canvas = document.createElement("canvas");
    this.canvas.dataset.engine = "mediabunny";
    this.context = this.canvas.getContext("2d", { alpha: false });
    this.container.appendChild(this.canvas);

    this.state = "idle";
    this.wantsPlayback = false;
    this.duration = 0;
    this.firstTimestamp = 0;
    this.videoQueue = [];
    this.videoEnded = false;
    this.audioEnded = false;
    this.generation = 0;
    this.destroyed = false;
    this.volume = 1;
    this.audioGain = 1;
    this.lastRenderedTimestamp = 0;
    this.firstVideoRendered = false;
    this.lastTimeEventAt = 0;
    this.videoDecodeCount = 0;
    this.videoRenderCount = 0;
    this.videoDropCount = 0;
    this.videoStutterCount = 0;
    this.audioBufferCount = 0;
    this.videoCodec = null;
    this.audioCodec = null;
    this.width = 0;
    this.height = 0;
    this.videoFaultUntil = 0;
    this.scheduledFaultTriggered = false;

    this.renderFrame = this.renderFrame.bind(this);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  }

  async load(source, { startTime = 0, duration = 0, isLive = false } = {}) {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
      throw new Error("Mediabunny engine requires COOP/COEP and SharedArrayBuffer");
    }
    this.setState("loading");
    if (source?.type === "split-mp4") {
      const videoInput = this.createInput(source.videoUrl, { boundedRanges: true });
      const audioInput = this.createInput(source.audioUrl, { boundedRanges: true });
      this.inputs.push(videoInput, audioInput);
      if (!await videoInput.canRead() || !await audioInput.canRead()) {
        throw new Error("Mediabunny could not recognize the split MP4 sources");
      }
      this.videoTrack = await videoInput.getPrimaryVideoTrack();
      this.audioTrack = await audioInput.getPrimaryAudioTrack();
    } else {
      const url = typeof source === "string" ? source : source?.url;
      if (!url) throw new Error("Missing MP4/HLS source URL");
      const isHls = source?.type === "hls" || /\.m3u8(?:[?#]|$)/i.test(url);
      this.input = this.createInput(url, { boundedRanges: !isHls });
      this.inputs.push(this.input);
      if (!await this.input.canRead()) {
        throw new Error("Mediabunny could not recognize this MP4/HLS source");
      }
      this.videoTrack = await this.input.getPrimaryVideoTrack();
      this.audioTrack = await this.input.getPrimaryAudioTrack();
    }
    if (!this.videoTrack && !this.audioTrack) {
      throw new Error("Source has no playable audio or video track");
    }
    if (this.videoTrack && typeof VideoDecoder !== "function") {
      throw new Error("Mediabunny engine requires WebCodecs VideoDecoder");
    }
    if (this.videoTrack && !await this.videoTrack.canDecode()) {
      throw new Error(`Browser cannot decode video codec: ${await this.videoTrack.getCodec()}`);
    }
    if (this.audioTrack && !await this.audioTrack.canDecode()) {
      throw new Error(`Browser cannot decode audio codec: ${await this.audioTrack.getCodec()}`);
    }

    const tracks = [this.videoTrack, this.audioTrack].filter(Boolean);
    const firstTimestamps = await Promise.all(tracks.map((track) => track.getFirstTimestamp()));
    this.firstTimestamp = Math.min(...firstTimestamps);
    const durationHint = Number(duration);
    if (Number.isFinite(durationHint) && durationHint > 0) {
      // yt-dlp/Plex already know the presentation duration. Fragmented MP4
      // tracks often omit it from their metadata; computeDuration() then has
      // to scan every moof in a multi-gigabyte file before decoding can start.
      this.duration = durationHint;
    } else {
      const durations = await Promise.all(tracks.map(async (track) => (
        await track.getDurationFromMetadata({ skipLiveWait: isLive })
        ?? await track.computeDuration({ skipLiveWait: isLive })
      )));
      this.duration = Math.max(...durations);
    }
    this.videoCodec = this.videoTrack ? await this.videoTrack.getCodec() : null;
    this.audioCodec = this.audioTrack ? await this.audioTrack.getCodec() : null;

    if (this.videoTrack) {
      this.width = await this.videoTrack.getDisplayWidth();
      this.height = await this.videoTrack.getDisplayHeight();
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.videoSink = new CanvasSink(this.videoTrack, {
        poolSize: VIDEO_QUEUE_CAPACITY + 2,
        fit: "contain",
        decoderOptions: {
          hardwareAcceleration: "prefer-hardware",
          optimizeForLatency: true,
        },
      });
    } else {
      this.canvas.hidden = true;
    }

    if (this.audioTrack) {
      await this.initializeAudio();
      this.audioSink = new AudioBufferSink(this.audioTrack);
    }

    const initialTime = clamp(startTime || this.firstTimestamp, this.firstTimestamp, this.duration || Infinity);
    await this.restartProducers(initialTime);
    this.setState("paused");
    return this;
  }

  createInput(url, { boundedRanges = true } = {}) {
    return new Input({
      source: new UrlSource(new URL(url, location.href).href, {
        ...(boundedRanges ? { fetchFn: boundedRangeFetch } : {}),
        maxCacheSize: 16 * 1024 * 1024,
        parallelism: 2,
      }),
      formats: HLS_FORMATS,
    });
  }

  async initializeAudio() {
    if (typeof AudioWorkletNode !== "function") {
      throw new Error("Mediabunny engine requires AudioWorklet");
    }

    const requestedSampleRate = await this.audioTrack.getSampleRate();
    const channels = await this.audioTrack.getNumberOfChannels();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass({ sampleRate: requestedSampleRate });
    if (this.audioContext.sampleRate !== requestedSampleRate) {
      throw new Error(
        `Audio sample-rate conversion is not implemented (${requestedSampleRate} -> ${this.audioContext.sampleRate})`,
      );
    }

    await this.audioContext.audioWorklet.addModule(
      new URL("./audio-worklet-processor.js", import.meta.url),
    );

    this.audioRing = new AudioRingBuffer({
      capacityFrames: Math.ceil(this.audioContext.sampleRate * AUDIO_CAPACITY_SECONDS),
      channels,
    });
    this.audioNode = new AudioWorkletNode(this.audioContext, "drivein-audio-output-v1", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: this.audioRing.processorOptions,
    });
    this.audioNode.port.onmessage = (event) => {
      if (event.data?.type === "underrun" && this.wantsPlayback) {
        this.enterBuffering("audio-underrun");
      }
    };

    this.gainNode = this.audioContext.createGain();
    this.compressorNode = this.audioContext.createDynamicsCompressor();
    this.compressorNode.threshold.value = -24;
    this.compressorNode.knee.value = 12;
    this.compressorNode.ratio.value = 8;
    this.compressorNode.attack.value = 0.003;
    this.compressorNode.release.value = 0.15;
    this.audioNode.connect(this.gainNode);
    this.gainNode.connect(this.compressorNode);
    this.compressorNode.connect(this.audioContext.destination);
    this.updateGain();
    this.clock.useAudioRing(this.audioRing, this.audioContext.sampleRate);
  }

  async restartProducers(mediaTime) {
    const generation = ++this.generation;
    this.videoIterator?.return?.().catch?.(() => {});
    this.audioIterator?.return?.().catch?.(() => {});
    this.videoQueue.length = 0;
    this.videoEnded = !this.videoTrack;
    this.audioEnded = !this.audioTrack;
    this.audioRing?.reset();
    this.clock.reset(mediaTime);
    this.lastRenderedTimestamp = mediaTime;
    this.firstVideoRendered = false;

    if (this.videoSink) {
      this.videoIterator = this.videoSink.canvases(mediaTime);
      void this.produceVideo(generation);
    }
    if (this.audioSink) {
      this.audioIterator = this.audioSink.buffers(mediaTime);
      void this.produceAudio(generation, mediaTime);
    }
  }

  async produceVideo(generation) {
    try {
      while (generation === this.generation && !this.destroyed) {
        while (this.videoQueue.length >= VIDEO_QUEUE_CAPACITY) {
          if (generation !== this.generation || this.destroyed) return;
          await wait(10);
        }

        await this.waitForVideoFault(generation);
        const result = await this.videoIterator.next();
        if (generation !== this.generation || this.destroyed) return;
        if (result.done) {
          this.videoEnded = true;
          return;
        }
        this.videoQueue.push(result.value);
        this.videoDecodeCount += 1;
      }
    } catch (error) {
      if (generation === this.generation && !this.destroyed) this.fail(error);
    }
  }

  async produceAudio(generation, mediaTime) {
    let firstBuffer = true;
    try {
      while (generation === this.generation && !this.destroyed) {
        const result = await this.audioIterator.next();
        if (generation !== this.generation || this.destroyed) return;
        if (result.done) {
          this.audioEnded = true;
          return;
        }

        const { buffer, timestamp } = result.value;
        let startFrame = 0;
        if (firstBuffer && timestamp < mediaTime) {
          startFrame = Math.round((mediaTime - timestamp) * buffer.sampleRate);
        }
        firstBuffer = false;
        const wrote = await this.audioRing.writeAudioBuffer(buffer, {
          startFrame,
          shouldContinue: () => generation === this.generation && !this.destroyed,
        });
        if (!wrote) return;
        this.audioBufferCount += 1;
      }
    } catch (error) {
      if (generation === this.generation && !this.destroyed) this.fail(error);
    }
  }

  async play() {
    this.wantsPlayback = true;
    if (this.audioContext && this.audioContext.state !== "running" && this.audioContext.state !== "closed") {
      await this.audioContext.resume();
    }
    this.updatePlaybackBarrier();
  }

  async pause() {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("paused");
  }

  async resume() {
    return this.play();
  }

  async seek(milliseconds) {
    const seconds = typeof milliseconds === "bigint"
      ? Number(milliseconds) / 1000
      : Number(milliseconds) / 1000;
    const target = clamp(seconds, this.firstTimestamp, this.duration || Infinity);
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("seeking");
    await this.restartProducers(target);
    if (this.wantsPlayback) this.enterBuffering("seek");
    else this.setState("paused");
  }

  async stop() {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("stopped");
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    cancelAnimationFrame(this.animationFrame);
    this.audioRing?.setRunning(false);
    await Promise.allSettled([
      this.videoIterator?.return?.(),
      this.audioIterator?.return?.(),
    ].filter(Boolean));
    for (const input of this.inputs) input.dispose();
    this.inputs.length = 0;
    try { this.audioNode?.disconnect(); } catch {}
    try { this.gainNode?.disconnect(); } catch {}
    try { this.compressorNode?.disconnect(); } catch {}
    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    this.canvas.remove();
    if (globalThis.__driveInMediabunny?.player === this) {
      delete globalThis.__driveInMediabunny;
    }
  }

  renderFrame(now) {
    if (this.destroyed) return;
    this.animationFrame = requestAnimationFrame(this.renderFrame);

    const mediaTime = this.clock.currentTime;
    this.maybeTriggerScheduledFault(mediaTime);
    this.updatePlaybackBarrier();
    this.renderVideo(mediaTime);

    if (now - this.lastTimeEventAt >= TIME_EVENT_INTERVAL_MS) {
      this.lastTimeEventAt = now;
      this.onTime(mediaTime);
    }

    if (
      this.duration > 0
      && mediaTime >= this.duration - 0.02
      && this.state !== "ended"
    ) {
      this.wantsPlayback = false;
      this.audioRing?.setRunning(false);
      this.clock.stop();
      this.setState("ended");
      this.onEnded();
    }
  }

  renderVideo(mediaTime) {
    if (!this.videoTrack || !this.videoQueue.length) return;

    let selected = null;
    while (this.videoQueue.length && this.videoQueue[0].timestamp <= mediaTime + 0.001) {
      if (selected) this.videoDropCount += 1;
      selected = this.videoQueue.shift();
    }
    if (!selected && !this.firstVideoRendered) selected = this.videoQueue[0];
    if (!selected) return;

    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(selected.canvas, 0, 0, this.canvas.width, this.canvas.height);
    this.lastRenderedTimestamp = selected.timestamp;
    this.videoRenderCount += 1;
    if (!this.firstVideoRendered) {
      this.firstVideoRendered = true;
      this.onFirstVideo();
    }
  }

  updatePlaybackBarrier() {
    if (!this.wantsPlayback || this.destroyed || this.state === "ended" || this.state === "error") return;

    const mediaTime = this.clock.currentTime;
    if (this.state === "playing") {
      if (!this.hasPlaybackSafetyMargin(mediaTime)) {
        this.enterBuffering("queue-low");
      }
      return;
    }

    if (this.hasStartupBuffer(mediaTime)) this.enterPlaying();
    else this.enterBuffering("waiting-for-both-tracks");
  }

  hasStartupBuffer(mediaTime) {
    const audioReady = !this.audioTrack
      || this.audioSeconds >= AUDIO_START_SECONDS
      || (this.audioEnded && this.audioRing.availableFrames > 0);
    const videoReady = !this.videoTrack
      || this.videoSecondsAhead(mediaTime) >= VIDEO_START_SECONDS
      || (this.videoEnded && this.videoQueue.length > 0);
    return audioReady && videoReady;
  }

  hasPlaybackSafetyMargin(mediaTime) {
    const audioSafe = !this.audioTrack
      || this.audioSeconds >= AUDIO_REBUFFER_SECONDS
      || this.audioEnded;
    const videoSafe = !this.videoTrack
      || this.videoSecondsAhead(mediaTime) >= VIDEO_REBUFFER_SECONDS
      || this.videoEnded;
    return audioSafe && videoSafe && !this.audioRing?.needsBuffering;
  }

  enterPlaying() {
    if (this.state === "playing") return;
    this.clock.start();
    this.audioRing?.setRunning(true);
    this.setState("playing");
  }

  enterBuffering(reason) {
    if (this.state === "buffering") return;
    if (reason.startsWith("video") || (reason === "queue-low" && this.videoTrack)) {
      this.videoStutterCount += 1;
    }
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("buffering", { reason });
  }

  videoSecondsAhead(mediaTime = this.clock.currentTime) {
    const last = this.videoQueue[this.videoQueue.length - 1];
    if (!last) return 0;
    return Math.max(0, last.timestamp + last.duration - mediaTime);
  }

  get audioSeconds() {
    if (!this.audioRing || !this.audioContext) return 0;
    return this.audioRing.availableFrames / this.audioContext.sampleRate;
  }

  injectVideoStall(durationMs) {
    const duration = Math.max(0, Number(durationMs) || 0);
    this.videoFaultUntil = Math.max(this.videoFaultUntil, performance.now() + duration);
    console.warn("[mediabunny] Injecting video read stall", { durationMs: duration });
  }

  maybeTriggerScheduledFault(mediaTime) {
    if (this.scheduledFaultTriggered || !this.faultInjection) return;
    if (mediaTime < this.faultInjection.atSeconds) return;
    this.scheduledFaultTriggered = true;
    this.injectVideoStall(this.faultInjection.durationMs);
  }

  async waitForVideoFault(generation) {
    while (performance.now() < this.videoFaultUntil) {
      if (generation !== this.generation || this.destroyed) return;
      await wait(Math.min(50, this.videoFaultUntil - performance.now()));
    }
  }

  setState(state, detail = {}) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    console.log("[mediabunny] state", { previous, state, ...detail });
    this.onStateChange(state, { previous, ...detail });
  }

  fail(error) {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("error");
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }

  updateGain() {
    if (this.gainNode) this.gainNode.gain.value = this.volume * this.audioGain;
  }

  setVolume(volume) {
    this.volume = clamp(Number(volume) || 0, 0, 1);
    this.updateGain();
  }

  setAudioGain(gain) {
    this.audioGain = Math.max(1, Number(gain) || 1);
    this.updateGain();
  }

  resize() {}

  getDuration() {
    return BigInt(Math.round(this.duration * 1000));
  }

  getStatus() {
    return this.state;
  }

  getStats() {
    const currentTimeMs = Math.round(this.clock.currentTime * 1000);
    return {
      audioFrameRenderCount: this.audioRing
        ? Math.floor(this.audioRing.consumedFrames / 128)
        : 0,
      audioCurrentTime: currentTimeMs,
      audioNextTime: currentTimeMs + Math.round(this.audioSeconds * 1000),
      audioStutter: this.audioRing?.underrunCount || 0,
      videoFrameDecodeCount: this.videoDecodeCount,
      videoFrameRenderCount: this.videoRenderCount,
      videoFrameDropCount: this.videoDropCount,
      videoCurrentTime: Math.round(this.lastRenderedTimestamp * 1000),
      videoNextTime: currentTimeMs + Math.round(this.videoSecondsAhead() * 1000),
      videoStutter: this.videoStutterCount,
      audiocodec: this.audioCodec,
      videocodec: this.videoCodec,
      width: this.width,
      height: this.height,
      engine: "mediabunny",
      audioBufferedMs: Math.round(this.audioSeconds * 1000),
      videoBufferedMs: Math.round(this.videoSecondsAhead() * 1000),
    };
  }
}
