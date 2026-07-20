// The player builds about 15 seconds of encoded startup buffer before its
// clock starts. Begin 15 seconds behind so wall-clock latency settles near the
// 30-second vehicle-safe target instead of adding both delays together.
const DEFAULT_CURSOR_LATENCY_SECONDS = 15;
const WINDOW_AHEAD_SECONDS = 150;
const WINDOW_BEHIND_SECONDS = 30;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseYoutubeLivePlaylist(body) {
  if (!body.includes("playlist_type/DVR") || !body.includes("googlevideo.com")) return null;
  const lines = body.split(/\r?\n/);
  const mediaSequence = finiteNumber(
    lines.find((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"))
      ?.slice("#EXT-X-MEDIA-SEQUENCE:".length),
  );
  const programDateTime = Date.parse(
    lines.find((line) => line.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))
      ?.slice("#EXT-X-PROGRAM-DATE-TIME:".length) || "",
  ) / 1000;
  const targetDuration = finiteNumber(
    lines.find((line) => line.startsWith("#EXT-X-TARGETDURATION:"))
      ?.slice("#EXT-X-TARGETDURATION:".length),
  );
  const segments = [];
  let pendingDuration = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = finiteNumber(line.slice("#EXTINF:".length).split(",", 1)[0]);
    } else if (pendingDuration != null && /^https?:\/\//i.test(line)) {
      const sequenceMatch = line.match(/\/sq\/(\d+)\//);
      if (sequenceMatch) {
        segments.push({
          sequence: Number(sequenceMatch[1]),
          duration: pendingDuration,
          url: line,
        });
      }
      pendingDuration = null;
    }
  }
  if (
    !Number.isInteger(mediaSequence)
    || mediaSequence < 0
    || !Number.isFinite(programDateTime)
    || !segments.length
  ) return null;
  const segmentDuration = segments[0].duration || targetDuration || 2;
  if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) return null;
  const latestSequence = segments[segments.length - 1].sequence;
  return {
    mediaSequence,
    latestSequence,
    segmentDuration,
    segmentUrlTemplate: segments[0].url,
    startedAt: programDateTime - mediaSequence * segmentDuration,
    liveEdge: programDateTime + segments.reduce((sum, segment) => sum + segment.duration, 0),
    targetDuration: targetDuration || Math.ceil(segmentDuration),
  };
}

export function sequenceForTime(session, time) {
  const requestedTime = finiteNumber(time);
  if (requestedTime == null) return null;
  return Math.max(
    0,
    Math.min(
      session.latestSequence,
      Math.floor((requestedTime - session.startedAt) / session.segmentDuration),
    ),
  );
}

export function segmentUrlForSequence(session, sequence) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > session.latestSequence) return null;
  return session.segmentUrlTemplate.replace(/\/sq\/\d+\//, `/sq/${sequence}/`);
}

export function buildYoutubeLiveWindow(session, {
  cursorSequence,
  sessionId,
  defaultLatencySeconds = DEFAULT_CURSOR_LATENCY_SECONDS,
  windowAheadSeconds = WINDOW_AHEAD_SECONDS,
  windowBehindSeconds = WINDOW_BEHIND_SECONDS,
} = {}) {
  const defaultCursor = session.latestSequence - Math.ceil(defaultLatencySeconds / session.segmentDuration);
  const playSequence = Math.max(
    0,
    Math.min(session.latestSequence, Number.isInteger(cursorSequence) ? cursorSequence : defaultCursor),
  );
  const startSequence = Math.max(
    0,
    playSequence - Math.ceil(windowBehindSeconds / session.segmentDuration),
  );
  const segmentCount = Math.max(1, Math.ceil(windowAheadSeconds / session.segmentDuration));
  // Advertise a bounded future runway. The segment endpoint waits until an
  // advertised sequence is published, which keeps live decoders open even
  // when playback is only a few seconds behind the edge.
  const endSequence = playSequence + segmentCount - 1;
  const encodedId = encodeURIComponent(sessionId);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(session.targetDuration)}`,
    `#EXT-X-MEDIA-SEQUENCE:${startSequence}`,
    `#EXT-X-PROGRAM-DATE-TIME:${new Date((session.startedAt + startSequence * session.segmentDuration) * 1000).toISOString()}`,
    `#EXT-X-DRIVE-IN-DVR-START:${session.startedAt}`,
    `#EXT-X-DRIVE-IN-LIVE-EDGE:${session.liveEdge}`,
    `#EXT-X-DRIVE-IN-PLAY-START:${session.startedAt + playSequence * session.segmentDuration}`,
  ];
  for (let sequence = startSequence; sequence <= endSequence; sequence += 1) {
    lines.push(`#EXTINF:${session.segmentDuration.toFixed(3)},`);
    lines.push(`/api/proxy/live-segment?id=${encodedId}&sq=${sequence}`);
  }
  return `${lines.join("\n")}\n`;
}
