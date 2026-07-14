const SEGMENT_PATTERN = /\.(?:m4s|mp4|ts)(?:[?#]|$)/i;
const PLAYLIST_PATTERN = /\.m3u8(?:[?#]|$)/i;

function requestUrl(input) {
  if (typeof input === "string") return new URL(input, location.href).href;
  if (input instanceof URL) return input.href;
  return input?.url ? new URL(input.url, location.href).href : "";
}

function responseFromCache(entry) {
  return new Response(entry.bytes, {
    status: entry.status,
    statusText: entry.statusText,
    headers: entry.headers,
  });
}

export class HlsSegmentPrefetcher {
  constructor({ ahead = 6, maxConcurrent = 1 } = {}) {
    this.ahead = ahead;
    this.maxConcurrent = maxConcurrent;
    this.segments = [];
    this.segmentIndexes = new Map();
    this.prefetches = new Map();
    this.controllers = new Set();
    this.currentIndex = -1;
    this.currentUrl = null;
    this.awaitingPlaylistUpdate = false;
    this.throughputSamples = [];
    this.ewmaThroughputBps = 0;
    this.completedDownloads = 0;
    this.generation = 0;
    this.destroyed = false;
  }

  async fetch(input, init = {}) {
    const url = requestUrl(input);
    if (!url) return globalThis.fetch(input, init);

    if (PLAYLIST_PATTERN.test(url)) {
      const response = await globalThis.fetch(input, init);
      if (response.ok) {
        const body = await response.clone().text();
        this.updatePlaylist(body, response.url || url);
      }
      return response;
    }

    const prefetched = this.prefetches.get(url);
    const segmentIndex = this.segmentIndexes.get(url);
    if (segmentIndex === undefined && !prefetched) return globalThis.fetch(input, init);
    if (segmentIndex !== undefined) {
      this.currentIndex = segmentIndex;
      this.currentUrl = url;
    }

    if (prefetched) {
      if (prefetched.state === "queued") this.startPrefetchEntry(prefetched);
      if (segmentIndex !== undefined && !this.awaitingPlaylistUpdate) this.scheduleAhead(segmentIndex + 1);
      const entry = await prefetched.promise;
      this.prefetches.delete(url);
      this.pumpPrefetches();
      if (entry) return responseFromCache(entry);
      for (const [pendingUrl, pendingEntry] of this.prefetches) {
        if (pendingEntry.state === "ready") continue;
        pendingEntry.controller?.abort();
        this.prefetches.delete(pendingUrl);
      }
    }

    const response = await globalThis.fetch(input, init);
    if (!this.awaitingPlaylistUpdate) {
      if (response.ok) void this.scheduleAfterForegroundDownload(response.clone(), segmentIndex + 1);
      else this.scheduleAhead(segmentIndex + 1);
    }
    return response;
  }

  updatePlaylist(body, playlistUrl) {
    const segments = [];
    let pendingDuration = 0;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("#EXTINF:")) {
        const duration = Number(line.slice("#EXTINF:".length).split(",", 1)[0]);
        pendingDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      } else if (line && !line.startsWith("#") && SEGMENT_PATTERN.test(line)) {
        segments.push({
          url: new URL(line, playlistUrl).href,
          duration: pendingDuration || 5,
        });
        pendingDuration = 0;
      }
    }
    if (!segments.length) return;

    const unchanged = segments.length === this.segments.length
      && segments.every((segment, index) => (
        segment.url === this.segments[index]?.url
        && segment.duration === this.segments[index]?.duration
      ));
    if (unchanged) {
      this.awaitingPlaylistUpdate = false;
      return;
    }

    const nextIndexes = new Map(segments.map((segment, index) => [segment.url, index]));
    for (const [url, entry] of this.prefetches) {
      const nextIndex = nextIndexes.get(url);
      if (nextIndex !== undefined) {
        entry.index = nextIndex;
        entry.orphanedAt = null;
        continue;
      }
      if (entry.state === "ready") {
        entry.orphanedAt ||= Date.now();
        continue;
      }
      entry.controller?.abort();
      this.prefetches.delete(url);
    }

    const orphanedReady = [...this.prefetches.entries()]
      .filter(([, entry]) => entry.state === "ready" && entry.orphanedAt)
      .sort((a, b) => b[1].orphanedAt - a[1].orphanedAt);
    for (const [url] of orphanedReady.slice(this.ahead)) this.prefetches.delete(url);

    this.segments = segments;
    this.segmentIndexes = nextIndexes;
    this.currentIndex = this.currentUrl ? nextIndexes.get(this.currentUrl) ?? -1 : -1;
    this.awaitingPlaylistUpdate = false;
    this.pumpPrefetches();
  }

  scheduleAhead(startIndex) {
    for (let index = startIndex; index < Math.min(this.segments.length, startIndex + this.ahead); index += 1) {
      const url = this.segments[index].url;
      if (this.prefetches.has(url)) continue;
      this.prefetches.set(url, {
        url,
        index,
        state: "queued",
        promise: null,
        controller: null,
      });
    }
    this.pumpPrefetches();
  }

  pumpPrefetches() {
    if (this.destroyed) return;
    let active = [...this.prefetches.values()].filter((entry) => entry.state === "pending").length;
    if (active >= this.maxConcurrent) return;
    const queued = [...this.prefetches.values()]
      .filter((entry) => entry.state === "queued")
      .sort((a, b) => a.index - b.index);
    for (const entry of queued) {
      if (active >= this.maxConcurrent) break;
      this.startPrefetchEntry(entry);
      active += 1;
    }
  }

  startPrefetchEntry(entry) {
    if (!entry || entry.state !== "queued") return entry?.promise || null;
    entry.state = "pending";
    entry.promise = this.prefetch(entry, this.generation).then((result) => {
      entry.state = result ? "ready" : "failed";
      return result;
    }).finally(() => this.pumpPrefetches());
    return entry.promise;
  }

  async prefetch(entry, generation) {
    const { url, index: segmentIndex } = entry;
    const controller = new AbortController();
    entry.controller = controller;
    this.controllers.add(controller);
    const startedAt = performance.now();
    try {
      const response = await globalThis.fetch(url, {
        headers: { Range: "bytes=0-" },
        priority: "low",
        signal: controller.signal,
      });
      if (!response.ok || generation !== this.generation || this.destroyed) return null;
      const bytes = await response.arrayBuffer();
      this.recordDownload(bytes.byteLength, performance.now() - startedAt, segmentIndex);
      return {
        bytes,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
      };
    } catch (error) {
      if (error?.name !== "AbortError") console.warn("[hls-prefetch] Segment prefetch failed:", error);
      return null;
    } finally {
      entry.controller = null;
      this.controllers.delete(controller);
    }
  }

  async scheduleAfterForegroundDownload(response, nextIndex) {
    try {
      await response.arrayBuffer();
    } catch {}
    if (!this.destroyed && !this.awaitingPlaylistUpdate) this.scheduleAhead(nextIndex);
  }

  recordDownload(byteLength, durationMs, segmentIndex) {
    if (!Number.isFinite(byteLength) || byteLength <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
    const bitsPerSecond = Math.min(100_000_000, (byteLength * 8 * 1000) / Math.max(20, durationMs));
    this.ewmaThroughputBps = this.ewmaThroughputBps
      ? this.ewmaThroughputBps * 0.65 + bitsPerSecond * 0.35
      : bitsPerSecond;
    this.throughputSamples.push(bitsPerSecond);
    if (this.throughputSamples.length > 8) this.throughputSamples.shift();
    this.completedDownloads += 1;
    this.lastDownload = {
      segmentIndex,
      byteLength,
      durationMs,
      bitsPerSecond,
    };
  }

  getStats() {
    const sorted = [...this.throughputSamples].sort((a, b) => a - b);
    const conservativeSample = sorted.length
      ? sorted[Math.floor((sorted.length - 1) * 0.25)]
      : 0;
    const throughputBps = conservativeSample && this.ewmaThroughputBps
      ? Math.min(conservativeSample, this.ewmaThroughputBps)
      : conservativeSample || this.ewmaThroughputBps;
    let bufferedAheadSeconds = 0;
    let readySegments = 0;
    let pendingSegments = 0;
    for (let index = this.currentIndex + 1; index < this.segments.length; index += 1) {
      const entry = this.prefetches.get(this.segments[index].url);
      if (!entry || entry.state !== "ready") break;
      bufferedAheadSeconds += this.segments[index].duration;
      readySegments += 1;
    }
    for (let index = this.currentIndex + 1; index < this.segments.length; index += 1) {
      const entry = this.prefetches.get(this.segments[index].url);
      if (!entry) continue;
      if (entry.state === "pending" || entry.state === "queued") {
        pendingSegments += 1;
      }
    }
    return {
      throughputKbps: throughputBps ? Math.round(throughputBps / 1000) : 0,
      sampleCount: this.throughputSamples.length,
      bufferedAheadSeconds,
      readySegments,
      pendingSegments,
      currentIndex: this.currentIndex,
      completedDownloads: this.completedDownloads,
      lastDownload: this.lastDownload || null,
    };
  }

  resetThroughputSamples() {
    this.throughputSamples = [];
    this.ewmaThroughputBps = 0;
    this.completedDownloads = 0;
    this.lastDownload = null;
  }

  handleBitrateSwitch() {
    this.resetThroughputSamples();
    this.awaitingPlaylistUpdate = true;
    for (const [url, entry] of this.prefetches) {
      if (entry.state === "ready") continue;
      entry.controller?.abort();
      this.prefetches.delete(url);
    }
  }

  handleSeek() {
    this.cancelPrefetches();
    this.currentIndex = -1;
    this.currentUrl = null;
    this.awaitingPlaylistUpdate = false;
  }

  cancelPrefetches() {
    this.generation += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.prefetches.clear();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelPrefetches();
    this.segments = [];
    this.segmentIndexes.clear();
    this.currentUrl = null;
  }
}
