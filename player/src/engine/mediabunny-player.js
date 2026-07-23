import {
  AudioBufferSink,
  CanvasSink,
  HLS_FORMATS,
  Input,
  UrlSource,
  WEBM,
} from "mediabunny";
import { AudioRingBuffer } from "./audio-ring-buffer.js";
import { HlsSegmentPrefetcher } from "./hls-segment-prefetcher.js";
import { getPlaybackEndReason } from "./playback-end.js";
import { hasHlsStartupBuffer } from "./playback-buffer-policy.js";
import { estimateAudioOutputLatencySeconds, PresentationClock } from "./presentation-clock.js";
import { LatestOperation } from "../latest-operation.js";

const AUDIO_CAPACITY_SECONDS = 3;
const AUDIO_START_SECONDS = 0.75;
const AUDIO_REBUFFER_SECONDS = 0.15;
// Network resilience belongs in the encoded segment buffer. Keep only a short
// decoded-frame queue here to absorb decoder and render scheduling jitter.
const VIDEO_QUEUE_MIN_CAPACITY = 6;
const VIDEO_QUEUE_MAX_CAPACITY = 16;
const VIDEO_QUEUE_TARGET_SECONDS = 0.2;
const VIDEO_START_SECONDS = 0.1;
const VIDEO_REBUFFER_SECONDS = 0.08;
const TIME_EVENT_INTERVAL_MS = 250;
// In-car connections often disappear for tens of seconds at a time. Keep the
// encoded HLS buffer large while the fixed 720p60 profile stays predictable.
const HLS_BUFFER_TARGET_SECONDS = 210;
const HLS_START_SECONDS = 15;
const HLS_BUFFER_MAX_SEGMENTS = 90;
const HLS_BUFFER_MAX_BYTES = 128 * 1024 * 1024;
const HLS_PREFETCH_CONCURRENCY = 1;
// Large enough to keep a 1080p video queue fed across Cloudflare, while still
// preventing UrlSource's open-ended ranges from extending to multi-GB EOFs.
const NETWORK_RANGE_CHUNK_BYTES = 2 * 1024 * 1024;
const ITERATOR_CLOSE_TIMEOUT_MS = 1_500;

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

async function closeIterator(iterator) {
  if (typeof iterator?.return !== "function") return true;
  let timeout = null;
  const closed = Promise.resolve()
    .then(() => iterator.return())
    .then(() => true, () => false);
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), ITERATOR_CLOSE_TIMEOUT_MS);
  });
  const result = await Promise.race([closed, timedOut]);
  clearTimeout(timeout);
  return result;
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
    hlsStartSeconds = HLS_START_SECONDS,
  }) {
    this.container = container;
    this.onStateChange = onStateChange;
    this.onTime = onTime;
    this.onFirstVideo = onFirstVideo;
    this.onEnded = onEnded;
    this.onError = onError;
    this.faultInjection = faultInjection;
    this.hlsStartSeconds = clamp(Number(hlsStartSeconds) || HLS_START_SECONDS, 1, HLS_START_SECONDS);

    this.input = null;
    this.inputs = [];
    this.videoTrack = null;
    this.audioTrack = null;
    this.videoSink = null;
    this.audioSink = null;
    this.videoIterator = null;
    this.audioIterator = null;
    this.producerRestarts = new LatestOperation();
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
    this.isLive = false;
    this.firstTimestamp = 0;
    this.videoQueue = [];
    this.videoQueueCapacity = VIDEO_QUEUE_MIN_CAPACITY;
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
    this.seekRequestCount = 0;
    this.seekSupersededCount = 0;
    this.iteratorCloseTimeoutCount = 0;
    this.lastSeekTarget = null;
    this.hlsSegmentPrefetcher = null;
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
    this.isLive = Boolean(isLive);
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
      this.input = this.createInput(url, { boundedRanges: !isHls, prefetchHls: isHls });
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
        poolSize: VIDEO_QUEUE_MAX_CAPACITY + 2,
        fit: "contain",
        decoderOptions: {
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

    const liveTimeline = this.getLiveTimeline();
    const requestedInitialTime = startTime || liveTimeline?.playStartTime || this.firstTimestamp;
    const initialTime = clamp(requestedInitialTime, this.firstTimestamp, this.duration || Infinity);
    await this.restartProducers(initialTime);
    this.setState("paused");
    return this;
  }

  createInput(url, { boundedRanges = true, prefetchHls = false } = {}) {
    if (prefetchHls) {
      this.hlsSegmentPrefetcher = new HlsSegmentPrefetcher({
        ahead: HLS_BUFFER_MAX_SEGMENTS,
        targetAheadSeconds: HLS_BUFFER_TARGET_SECONDS,
        maxBytes: HLS_BUFFER_MAX_BYTES,
        maxConcurrent: HLS_PREFETCH_CONCURRENCY,
      });
    }
    return new Input({
      source: new UrlSource(new URL(url, location.href).href, {
        ...(boundedRanges ? { fetchFn: boundedRangeFetch } : {}),
        ...(prefetchHls ? { fetchFn: this.hlsSegmentPrefetcher.fetch.bind(this.hlsSegmentPrefetcher) } : {}),
        maxCacheSize: 16 * 1024 * 1024,
        parallelism: 2,
      }),
      formats: [...HLS_FORMATS, WEBM],
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
      if (event.data?.type === "underrun" && this.wantsPlayback && !this.audioEnded) {
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

  async restartProducers(mediaTime, {
    resetHlsBuffer = false,
    hlsSeekTarget = mediaTime,
  } = {}) {
    // Invalidate current producers immediately. Iterator teardown is serialized
    // below so rapid seeks cannot make an old producer consume a newer iterator.
    const generation = ++this.generation;
    return this.producerRestarts.run(async ({ isCurrent }) => {
      const videoIterator = this.videoIterator;
      const audioIterator = this.audioIterator;
      this.videoIterator = null;
      this.audioIterator = null;
      const closeResults = await Promise.all([
        closeIterator(videoIterator),
        closeIterator(audioIterator),
      ]);
      const closeFailures = closeResults.filter((closed) => !closed).length;
      if (closeFailures) {
        this.iteratorCloseTimeoutCount += closeFailures;
        console.warn("[mediabunny] Decoder iterator did not close cleanly", {
          closeFailures,
          target: mediaTime,
        });
      }
      if (!isCurrent() || generation !== this.generation || this.destroyed) return false;

      if (resetHlsBuffer) this.hlsSegmentPrefetcher?.handleSeek(hlsSeekTarget);
      this.videoQueue.length = 0;
      this.videoQueueCapacity = VIDEO_QUEUE_MIN_CAPACITY;
      this.videoEnded = !this.videoTrack;
      this.audioEnded = !this.audioTrack;
      this.audioRing?.reset();
      this.clock.reset(mediaTime);
      this.lastRenderedTimestamp = mediaTime;
      this.firstVideoRendered = false;

      if (this.videoSink) {
        const nextVideoIterator = this.videoSink.canvases(mediaTime);
        this.videoIterator = nextVideoIterator;
        void this.produceVideo(generation, nextVideoIterator);
      }
      if (this.audioSink) {
        const nextAudioIterator = this.audioSink.buffers(mediaTime);
        this.audioIterator = nextAudioIterator;
        void this.produceAudio(generation, mediaTime, nextAudioIterator);
      }
      return true;
    });
  }

  async produceVideo(generation, iterator) {
    try {
      while (generation === this.generation && !this.destroyed) {
        while (this.videoQueue.length >= this.videoQueueCapacity) {
          if (generation !== this.generation || this.destroyed) return;
          await wait(10);
        }

        await this.waitForVideoFault(generation);
        if (generation !== this.generation || this.destroyed) return;
        const result = await iterator.next();
        if (generation !== this.generation || this.destroyed) return;
        if (result.done) {
          this.videoEnded = true;
          return;
        }
        const frameDuration = Number(result.value.duration);
        if (Number.isFinite(frameDuration) && frameDuration > 0) {
          this.videoQueueCapacity = clamp(
            Math.ceil(VIDEO_QUEUE_TARGET_SECONDS / frameDuration),
            VIDEO_QUEUE_MIN_CAPACITY,
            VIDEO_QUEUE_MAX_CAPACITY,
          );
        }
        this.videoQueue.push(result.value);
        this.videoDecodeCount += 1;
      }
    } catch (error) {
      if (generation === this.generation && !this.destroyed) this.fail(error);
    }
  }

  async produceAudio(generation, mediaTime, iterator) {
    let firstBuffer = true;
    try {
      while (generation === this.generation && !this.destroyed) {
        const result = await iterator.next();
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

  async seek(milliseconds, { preserveHlsBuffer = false } = {}) {
    const seconds = typeof milliseconds === "bigint"
      ? Number(milliseconds) / 1000
      : Number(milliseconds) / 1000;
    const target = clamp(seconds, this.firstTimestamp, this.duration || Infinity);
    this.seekRequestCount += 1;
    this.lastSeekTarget = target;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("seeking");
    const applied = await this.restartProducers(target, {
      resetHlsBuffer: !preserveHlsBuffer,
      hlsSeekTarget: target,
    });
    if (!applied) {
      this.seekSupersededCount += 1;
      return false;
    }
    if (this.wantsPlayback) this.enterBuffering("seek");
    else this.setState("paused");
    return true;
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
    this.producerRestarts.invalidate();
    cancelAnimationFrame(this.animationFrame);
    this.audioRing?.setRunning(false);
    await this.producerRestarts.idle();
    const videoIterator = this.videoIterator;
    const audioIterator = this.audioIterator;
    this.videoIterator = null;
    this.audioIterator = null;
    await Promise.allSettled([
      closeIterator(videoIterator),
      closeIterator(audioIterator),
    ].filter(Boolean));
    for (const input of this.inputs) input.dispose();
    this.inputs.length = 0;
    this.hlsSegmentPrefetcher?.destroy();
    this.hlsSegmentPrefetcher = null;
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
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    this.maybeTriggerScheduledFault(mediaTime);
    this.renderVideo(videoPresentationTime);
    const endReason = this.wantsPlayback ? getPlaybackEndReason({
      duration: this.duration,
      mediaTime,
      hasAudio: Boolean(this.audioTrack),
      hasVideo: Boolean(this.videoTrack),
      audioEnded: this.audioEnded,
      videoEnded: this.videoEnded,
      audioBufferedSeconds: this.audioSeconds,
      videoBufferedSeconds: this.videoSecondsAhead(videoPresentationTime),
      ignoreDurationBoundary: this.isLive,
    }) : null;
    if (endReason && this.state !== "ended") {
      this.finishPlayback(endReason);
      return;
    }

    this.updatePlaybackBarrier();
    if (now - this.lastTimeEventAt >= TIME_EVENT_INTERVAL_MS) {
      this.lastTimeEventAt = now;
      this.onTime(mediaTime);
    }

  }

  finishPlayback(reason) {
    this.wantsPlayback = false;
    this.audioRing?.setRunning(false);
    this.clock.stop();
    this.setState("ended", { reason });
    this.onEnded();
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

    if (this.hasStartupBuffer(mediaTime)) {
      this.enterPlaying();
    } else {
      const reason = this.hasDecodedStartupBuffer(mediaTime)
        ? "building-network-buffer"
        : "waiting-for-both-tracks";
      this.enterBuffering(reason);
    }
  }

  hasDecodedStartupBuffer(mediaTime) {
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    const audioReady = !this.audioTrack
      || this.audioSeconds >= AUDIO_START_SECONDS
      || (this.audioEnded && this.audioRing.availableFrames > 0);
    const videoReady = !this.videoTrack
      || this.videoSecondsAhead(videoPresentationTime) >= VIDEO_START_SECONDS
      // A high-frame-rate stream can hit the strict memory cap before reaching
      // the time target. A full queue is still enough decoded work to start.
      || this.videoQueue.length >= this.videoQueueCapacity
      || (this.videoEnded && this.videoQueue.length > 0);
    return audioReady && videoReady;
  }

  hasStartupBuffer(mediaTime) {
    return hasHlsStartupBuffer({
      decodedReady: this.hasDecodedStartupBuffer(mediaTime),
      network: this.hlsSegmentPrefetcher?.getStats() || null,
      mediaTime,
      duration: this.isLive ? 0 : this.duration,
      requiredStartSeconds: this.hlsStartSeconds || HLS_START_SECONDS,
    });
  }

  hasPlaybackSafetyMargin(mediaTime) {
    const videoPresentationTime = this.getVideoPresentationTime(mediaTime);
    const audioSafe = !this.audioTrack
      || this.audioSeconds >= AUDIO_REBUFFER_SECONDS
      || this.audioEnded;
    const videoSafe = !this.videoTrack
      || this.videoSecondsAhead(videoPresentationTime) >= VIDEO_REBUFFER_SECONDS
      || this.videoEnded;
    const unexpectedAudioUnderrun = this.audioRing?.needsBuffering && !this.audioEnded;
    return audioSafe && videoSafe && !unexpectedAudioUnderrun;
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

  getAudioOutputLatencySeconds() {
    return estimateAudioOutputLatencySeconds(this.audioContext);
  }

  getVideoPresentationTime(mediaTime = this.clock.currentTime) {
    return Math.max(
      this.firstTimestamp,
      mediaTime - this.getAudioOutputLatencySeconds(),
    );
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

  getCurrentTime() {
    return this.clock.currentTime;
  }

  getLiveTimeline() {
    if (!this.isLive) return null;
    const stats = this.hlsSegmentPrefetcher?.getStats();
    if (!Number.isFinite(stats?.liveDvrStartTime) || !Number.isFinite(stats?.liveEdgeTime)) return null;
    return {
      startTime: stats.liveDvrStartTime,
      edgeTime: stats.liveEdgeTime,
      playStartTime: stats.livePlayStartTime,
    };
  }

  getStats() {
    const currentTimeMs = Math.round(this.clock.currentTime * 1000);
    const audioOutputLatencyMs = Math.round(this.getAudioOutputLatencySeconds() * 1000);
    const videoPresentationTime = this.getVideoPresentationTime();
    const hlsNetwork = this.hlsSegmentPrefetcher?.getStats() || null;
    return {
      audioFrameRenderCount: this.audioRing
        ? Math.floor(this.audioRing.consumedFrames / 128)
        : 0,
      audioCurrentTime: currentTimeMs,
      audibleAudioCurrentTime: currentTimeMs - audioOutputLatencyMs,
      audioOutputLatencyMs,
      audioNextTime: currentTimeMs + Math.round(this.audioSeconds * 1000),
      audioStutter: this.audioRing?.underrunCount || 0,
      videoFrameDecodeCount: this.videoDecodeCount,
      videoFrameRenderCount: this.videoRenderCount,
      videoFrameDropCount: this.videoDropCount,
      videoCurrentTime: Math.round(this.lastRenderedTimestamp * 1000),
      videoNextTime: Math.round(
        (videoPresentationTime + this.videoSecondsAhead(videoPresentationTime)) * 1000,
      ),
      videoStutter: this.videoStutterCount,
      seekRequestCount: this.seekRequestCount,
      seekSupersededCount: this.seekSupersededCount,
      iteratorCloseTimeoutCount: this.iteratorCloseTimeoutCount,
      lastSeekTarget: this.lastSeekTarget,
      audiocodec: this.audioCodec,
      videocodec: this.videoCodec,
      width: this.width,
      height: this.height,
      engine: "mediabunny",
      bandwidth: hlsNetwork?.throughputKbps ? hlsNetwork.throughputKbps * 1000 : null,
      hlsThroughputSampleCount: hlsNetwork?.sampleCount ?? null,
      audioBufferedMs: Math.round(this.audioSeconds * 1000),
      videoBufferedMs: Math.round(this.videoSecondsAhead(videoPresentationTime) * 1000),
      audioSourceEnded: this.audioEnded,
      videoSourceEnded: this.videoEnded,
      durationDistanceMs: this.duration > 0
        ? Math.round((this.duration - this.clock.currentTime) * 1000)
        : null,
      hlsBufferedAheadSeconds: hlsNetwork?.bufferedAheadSeconds ?? null,
      hlsBufferedBytes: hlsNetwork?.cachedBytes ?? null,
      hlsCachedSegments: hlsNetwork?.cachedSegments ?? null,
      hlsPendingSegments: hlsNetwork?.pendingSegments ?? null,
      hlsActiveDownloads: hlsNetwork?.activeDownloads ?? null,
      hlsQueuedSegments: hlsNetwork?.queuedSegments ?? null,
      hlsRetryWaitingSegments: hlsNetwork?.retryWaitingSegments ?? null,
      hlsOldestActiveDownloadMs: hlsNetwork?.oldestActiveDownloadMs ?? null,
      hlsNetworkRetryCount: hlsNetwork?.networkRetryCount ?? null,
      hlsTimeoutCount: hlsNetwork?.timeoutCount ?? null,
      hlsFailureCount: hlsNetwork?.failureCount ?? null,
      hlsLastFailure: hlsNetwork?.lastFailure ?? null,
      hlsBufferMaxBytes: hlsNetwork?.maxBytes ?? null,
      hlsBufferTargetSeconds: hlsNetwork?.targetAheadSeconds ?? null,
      hlsBufferCacheUtilization: hlsNetwork?.cacheUtilization ?? null,
      hlsPeakBufferedBytes: hlsNetwork?.peakCachedBytes ?? null,
      hlsPeakBufferedAheadSeconds: hlsNetwork?.peakBufferedAheadSeconds ?? null,
      hlsManagedBytesEstimate: hlsNetwork?.managedBytesEstimate ?? null,
      hlsPeakManagedBytesEstimate: hlsNetwork?.peakManagedBytesEstimate ?? null,
      hlsBufferByteCapHitCount: hlsNetwork?.byteCapHitCount ?? null,
      liveDvrStartTime: hlsNetwork?.liveDvrStartTime ?? null,
      liveEdgeTime: hlsNetwork?.liveEdgeTime ?? null,
      livePlayStartTime: hlsNetwork?.livePlayStartTime ?? null,
      liveLatencyMs: Number.isFinite(hlsNetwork?.liveEdgeTime)
        ? Math.max(0, Math.round((hlsNetwork.liveEdgeTime - this.clock.currentTime) * 1000))
        : null,
    };
  }
}
