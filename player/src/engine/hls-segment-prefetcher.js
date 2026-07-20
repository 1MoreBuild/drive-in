const SEGMENT_PATTERN = /\.(?:m4s|mp4|ts)(?:[?#]|$)/i;
const PLAYLIST_PATTERN = /(?:\.m3u8|\/api\/proxy\/hls)(?:[?#]|$)/i;

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
  constructor({
    ahead = 90,
    targetAheadSeconds = 180,
    maxBytes = 96 * 1024 * 1024,
    maxConcurrent = 1,
  } = {}) {
    this.ahead = ahead;
    this.targetAheadSeconds = targetAheadSeconds;
    this.maxBytes = maxBytes;
    this.maxConcurrent = maxConcurrent;
    this.playlists = new Map();
    this.segmentIndexes = new Map();
    this.prefetches = new Map();
    this.controllers = new Set();
    this.awaitingPlaylistUpdate = false;
    this.throughputSamples = [];
    this.ewmaThroughputBps = 0;
    this.completedDownloads = 0;
    this.segmentSizeSamples = [];
    this.peakCachedBytes = 0;
    this.peakBufferedAheadSeconds = 0;
    this.peakManagedBytesEstimate = 0;
    this.byteCapHitCount = 0;
    this.atByteCap = false;
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
    const segmentRef = this.segmentIndexes.get(url);
    const playlist = segmentRef ? this.playlists.get(segmentRef.playlistUrl) : null;
    if (!segmentRef && !prefetched) return globalThis.fetch(input, init);
    const advanced = segmentRef && playlist
      ? this.advancePlaylist(playlist, segmentRef.index, url)
      : false;

    if (prefetched) {
      if (prefetched.state === "queued") this.startPrefetchEntry(prefetched);
      if (advanced && !this.awaitingPlaylistUpdate) {
        this.scheduleAhead(segmentRef.playlistUrl, segmentRef.index + 1);
      }
      const entry = await prefetched.promise;
      this.prefetches.delete(url);
      this.pumpPrefetches();
      if (entry) return responseFromCache(entry);
      for (const [pendingUrl, pendingEntry] of this.prefetches) {
        if (pendingEntry.playlistUrl !== prefetched.playlistUrl) continue;
        if (pendingEntry.state === "ready") continue;
        pendingEntry.controller?.abort();
        this.prefetches.delete(pendingUrl);
      }
    }

    const response = await globalThis.fetch(input, init);
    if (!this.awaitingPlaylistUpdate && segmentRef && advanced) {
      if (response.ok) {
        void this.scheduleAfterForegroundDownload(
          response.clone(),
          segmentRef.playlistUrl,
          segmentRef.index + 1,
        );
      } else {
        this.scheduleAhead(segmentRef.playlistUrl, segmentRef.index + 1);
      }
    }
    return response;
  }

  advancePlaylist(playlist, index, url) {
    if (index < playlist.currentIndex) return false;
    playlist.currentIndex = index;
    playlist.currentUrl = url;
    for (const [pendingUrl, entry] of this.prefetches) {
      if (entry.playlistUrl !== playlist.url || entry.index >= index) continue;
      entry.controller?.abort();
      this.prefetches.delete(pendingUrl);
    }
    return true;
  }

  updatePlaylist(body, playlistUrl) {
    const segments = [];
    let pendingDuration = null;
    let liveDvrStartTime = null;
    let liveEdgeTime = null;
    let livePlayStartTime = null;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("#EXT-X-DRIVE-IN-DVR-START:")) {
        const value = Number(line.slice("#EXT-X-DRIVE-IN-DVR-START:".length));
        if (Number.isFinite(value)) liveDvrStartTime = value;
      } else if (line.startsWith("#EXT-X-DRIVE-IN-LIVE-EDGE:")) {
        const value = Number(line.slice("#EXT-X-DRIVE-IN-LIVE-EDGE:".length));
        if (Number.isFinite(value)) liveEdgeTime = value;
      } else if (line.startsWith("#EXT-X-DRIVE-IN-PLAY-START:")) {
        const value = Number(line.slice("#EXT-X-DRIVE-IN-PLAY-START:".length));
        if (Number.isFinite(value)) livePlayStartTime = value;
      } else if (line.startsWith("#EXTINF:")) {
        const duration = Number(line.slice("#EXTINF:".length).split(",", 1)[0]);
        pendingDuration = Number.isFinite(duration) && duration >= 0 ? duration : null;
      } else if (
        line
        && !line.startsWith("#")
        && (pendingDuration !== null || SEGMENT_PATTERN.test(line))
      ) {
        segments.push({
          url: new URL(line, playlistUrl).href,
          duration: pendingDuration ?? 5,
        });
        pendingDuration = null;
      }
    }
    if (!segments.length) return;

    const previous = this.playlists.get(playlistUrl);
    const unchanged = segments.length === previous?.segments.length
      && segments.every((segment, index) => (
        segment.url === previous.segments[index]?.url
        && segment.duration === previous.segments[index]?.duration
      ));
    if (unchanged) {
      this.awaitingPlaylistUpdate = false;
      return;
    }

    const nextIndexes = new Map(segments.map((segment, index) => [segment.url, index]));
    for (const [url, entry] of this.prefetches) {
      if (entry.playlistUrl !== playlistUrl) continue;
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

    if (previous) {
      for (const segment of previous.segments) this.segmentIndexes.delete(segment.url);
    }
    const playlist = {
      url: playlistUrl,
      segments,
      currentUrl: previous?.currentUrl || null,
      currentIndex: previous?.currentUrl ? nextIndexes.get(previous.currentUrl) ?? -1 : -1,
      liveDvrStartTime,
      liveEdgeTime,
      livePlayStartTime,
      liveEdgeObservedAt: performance.now(),
    };
    this.playlists.set(playlistUrl, playlist);
    for (const [url, index] of nextIndexes) {
      this.segmentIndexes.set(url, { playlistUrl, index });
    }
    this.awaitingPlaylistUpdate = false;
    this.pumpPrefetches();
  }

  scheduleAhead(playlistUrl, startIndex) {
    const playlist = this.playlists.get(playlistUrl);
    if (!playlist) return;
    let scheduledSeconds = 0;
    const endIndex = Math.min(playlist.segments.length, startIndex + this.ahead);
    for (let index = startIndex; index < endIndex; index += 1) {
      const url = playlist.segments[index].url;
      if (!this.prefetches.has(url)) {
        this.prefetches.set(url, {
          url,
          playlistUrl,
          index,
          state: "queued",
          promise: null,
          controller: null,
        });
      }
      scheduledSeconds += playlist.segments[index].duration;
      if (scheduledSeconds >= this.targetAheadSeconds) break;
    }
    this.pumpPrefetches();
  }

  pumpPrefetches() {
    if (this.destroyed) return;
    if (this.cachedBytes >= this.maxBytes) {
      this.markByteCapReached();
      return;
    }
    let active = [...this.prefetches.values()].filter((entry) => entry.state === "pending").length;
    if (active >= this.maxConcurrent) return;
    const queued = [...this.prefetches.values()]
      .filter((entry) => entry.state === "queued")
      .sort((a, b) => {
        const aCurrent = this.playlists.get(a.playlistUrl)?.currentIndex ?? -1;
        const bCurrent = this.playlists.get(b.playlistUrl)?.currentIndex ?? -1;
        const aDistance = a.index - aCurrent;
        const bDistance = b.index - bCurrent;
        return aDistance - bDistance || a.index - b.index;
      });
    for (const entry of queued) {
      if (active >= this.maxConcurrent) break;
      const estimate = this.averageSegmentBytes;
      if (
        estimate > 0
        && this.cachedBytes + this.pendingEstimatedBytes + estimate > this.maxBytes
      ) {
        this.markByteCapReached();
        break;
      }
      entry.estimatedByteLength = estimate;
      this.atByteCap = false;
      this.startPrefetchEntry(entry);
      active += 1;
    }
  }

  startPrefetchEntry(entry) {
    if (!entry || entry.state !== "queued") return entry?.promise || null;
    entry.state = "pending";
    entry.promise = this.prefetch(entry, this.generation).then((result) => {
      entry.state = result ? "ready" : "failed";
      entry.byteLength = result?.bytes?.byteLength || 0;
      entry.estimatedByteLength = 0;
      if (result) {
        this.updateCachePeaks();
        this.trimReadyCacheToBudget();
      }
      return result;
    }).finally(() => this.pumpPrefetches());
    this.updateCachePeaks();
    return entry.promise;
  }

  async prefetch(entry, generation) {
    const { url, playlistUrl, index: segmentIndex } = entry;
    const controller = new AbortController();
    entry.controller = controller;
    this.controllers.add(controller);
    const startedAt = performance.now();
    try {
      const response = await globalThis.fetch(url, {
        headers: { Range: "bytes=0-", "X-Drive-In-Prefetch": "1" },
        priority: "low",
        signal: controller.signal,
      });
      if (!response.ok || generation !== this.generation || this.destroyed) return null;
      const bytes = await response.arrayBuffer();
      this.recordDownload(bytes.byteLength, performance.now() - startedAt, segmentIndex, playlistUrl);
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

  async scheduleAfterForegroundDownload(response, playlistUrl, nextIndex) {
    try {
      await response.arrayBuffer();
    } catch {}
    const playlist = this.playlists.get(playlistUrl);
    if (
      !this.destroyed
      && !this.awaitingPlaylistUpdate
      && playlist
      && nextIndex > playlist.currentIndex
    ) {
      this.scheduleAhead(playlistUrl, nextIndex);
    }
  }

  recordDownload(byteLength, durationMs, segmentIndex, playlistUrl = null) {
    if (!Number.isFinite(byteLength) || byteLength <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
    const bitsPerSecond = Math.min(100_000_000, (byteLength * 8 * 1000) / Math.max(20, durationMs));
    this.ewmaThroughputBps = this.ewmaThroughputBps
      ? this.ewmaThroughputBps * 0.65 + bitsPerSecond * 0.35
      : bitsPerSecond;
    this.throughputSamples.push(bitsPerSecond);
    if (this.throughputSamples.length > 8) this.throughputSamples.shift();
    this.segmentSizeSamples.push(byteLength);
    if (this.segmentSizeSamples.length > 8) this.segmentSizeSamples.shift();
    this.completedDownloads += 1;
    this.lastDownload = {
      segmentIndex,
      playlistUrl,
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
    const activePlaylists = [...this.playlists.values()]
      .filter((playlist) => playlist.currentIndex >= 0);
    const playlistStats = activePlaylists.map((playlist) => {
      let bufferedAheadSeconds = 0;
      let readySegments = 0;
      let pendingSegments = 0;
      for (let index = playlist.currentIndex + 1; index < playlist.segments.length; index += 1) {
        const entry = this.prefetches.get(playlist.segments[index].url);
        if (!entry || entry.state !== "ready") break;
        bufferedAheadSeconds += playlist.segments[index].duration;
        readySegments += 1;
      }
      for (let index = playlist.currentIndex + 1; index < playlist.segments.length; index += 1) {
        const entry = this.prefetches.get(playlist.segments[index].url);
        if (entry?.state === "pending" || entry?.state === "queued") pendingSegments += 1;
      }
      return {
        playlistUrl: playlist.url,
        currentIndex: playlist.currentIndex,
        bufferedAheadSeconds,
        readySegments,
        pendingSegments,
      };
    });
    const bufferedAheadSeconds = playlistStats.length
      ? Math.min(...playlistStats.map((stats) => stats.bufferedAheadSeconds))
      : 0;
    let readySegments = 0;
    let pendingSegments = 0;
    for (const stats of playlistStats) {
      readySegments += stats.readySegments;
      pendingSegments += stats.pendingSegments;
    }
    const cachedBytes = this.cachedBytes;
    const cachedSegments = [...this.prefetches.values()]
      .filter((entry) => entry.state === "ready").length;
    this.updateCachePeaks(bufferedAheadSeconds);
    const managedBytesEstimate = cachedBytes + this.pendingEstimatedBytes;
    const livePlaylists = activePlaylists.filter((playlist) => (
      Number.isFinite(playlist.liveDvrStartTime) && Number.isFinite(playlist.liveEdgeTime)
    ));
    const liveDvrStartTime = livePlaylists.length
      ? Math.min(...livePlaylists.map((playlist) => playlist.liveDvrStartTime))
      : null;
    const liveEdgeTime = livePlaylists.length
      ? Math.max(...livePlaylists.map((playlist) => (
          playlist.liveEdgeTime + Math.max(0, performance.now() - playlist.liveEdgeObservedAt) / 1000
        )))
      : null;
    const livePlayStartTime = livePlaylists.length
      ? Math.max(...livePlaylists.map((playlist) => playlist.livePlayStartTime || playlist.liveDvrStartTime))
      : null;
    return {
      throughputKbps: throughputBps ? Math.round(throughputBps / 1000) : 0,
      sampleCount: this.throughputSamples.length,
      bufferedAheadSeconds,
      readySegments,
      pendingSegments,
      cachedBytes,
      cachedSegments,
      maxBytes: this.maxBytes,
      targetAheadSeconds: this.targetAheadSeconds,
      maxAheadSegments: this.ahead,
      cacheUtilization: this.maxBytes > 0 ? cachedBytes / this.maxBytes : 0,
      peakCachedBytes: this.peakCachedBytes,
      peakBufferedAheadSeconds: this.peakBufferedAheadSeconds,
      managedBytesEstimate,
      peakManagedBytesEstimate: this.peakManagedBytesEstimate,
      byteCapHitCount: this.byteCapHitCount,
      activePlaylistCount: activePlaylists.length,
      playlistStats,
      completedDownloads: this.completedDownloads,
      lastDownload: this.lastDownload || null,
      liveDvrStartTime,
      liveEdgeTime,
      livePlayStartTime,
    };
  }

  get cachedBytes() {
    let bytes = 0;
    for (const entry of this.prefetches.values()) {
      if (entry.state === "ready") bytes += entry.byteLength || 0;
    }
    return bytes;
  }

  get pendingEstimatedBytes() {
    let bytes = 0;
    for (const entry of this.prefetches.values()) {
      if (entry.state === "pending") bytes += entry.estimatedByteLength || this.averageSegmentBytes;
    }
    return bytes;
  }

  get averageSegmentBytes() {
    if (!this.segmentSizeSamples.length) return 0;
    return this.segmentSizeSamples.reduce((sum, bytes) => sum + bytes, 0) / this.segmentSizeSamples.length;
  }

  contiguousBufferedAheadSeconds() {
    const activePlaylists = [...this.playlists.values()]
      .filter((playlist) => playlist.currentIndex >= 0);
    if (!activePlaylists.length) return 0;
    return Math.min(...activePlaylists.map((playlist) => {
      let seconds = 0;
      for (let index = playlist.currentIndex + 1; index < playlist.segments.length; index += 1) {
        const entry = this.prefetches.get(playlist.segments[index].url);
        if (!entry || entry.state !== "ready") break;
        seconds += playlist.segments[index].duration;
      }
      return seconds;
    }));
  }

  updateCachePeaks(bufferedAheadSeconds = this.contiguousBufferedAheadSeconds()) {
    const cachedBytes = this.cachedBytes;
    const managedBytesEstimate = cachedBytes + this.pendingEstimatedBytes;
    this.peakCachedBytes = Math.max(this.peakCachedBytes, cachedBytes);
    this.peakBufferedAheadSeconds = Math.max(this.peakBufferedAheadSeconds, bufferedAheadSeconds);
    this.peakManagedBytesEstimate = Math.max(this.peakManagedBytesEstimate, managedBytesEstimate);
  }

  markByteCapReached() {
    if (!this.atByteCap) this.byteCapHitCount += 1;
    this.atByteCap = true;
  }

  trimReadyCacheToBudget() {
    let cachedBytes = this.cachedBytes;
    if (cachedBytes <= this.maxBytes) return;
    this.markByteCapReached();
    const farthestFirst = [...this.prefetches.entries()]
      .filter(([, entry]) => entry.state === "ready")
      .sort((a, b) => b[1].index - a[1].index);
    for (const [url, entry] of farthestFirst) {
      if (cachedBytes <= this.maxBytes) break;
      this.prefetches.delete(url);
      cachedBytes -= entry.byteLength || 0;
    }
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
    this.playlists.clear();
    this.segmentIndexes.clear();
  }

  handleSeek() {
    this.cancelPrefetches();
    for (const playlist of this.playlists.values()) {
      playlist.currentIndex = -1;
      playlist.currentUrl = null;
    }
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
    this.playlists.clear();
    this.segmentIndexes.clear();
  }
}
