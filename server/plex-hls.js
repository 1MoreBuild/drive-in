export function trimPlexHlsResumePlaceholders(body, { onTrim = null } = {}) {
  const hadTrailingNewline = body.endsWith("\n");
  const lines = body.split(/\r?\n/);
  const startLine = lines.find((line) => line.startsWith("#EXT-X-START:"));
  const offsetMatch = startLine?.match(/TIME-OFFSET=(-?\d+(?:\.\d+)?)/i);
  const resumeOffset = Number(offsetMatch?.[1]);
  if (!Number.isFinite(resumeOffset) || resumeOffset <= 0) return body;

  const firstSegmentIndex = lines.findIndex((line) => line.startsWith("#EXTINF:"));
  if (firstSegmentIndex === -1) return body;

  let accumulatedDuration = 0;
  let droppedSegments = 0;
  let firstKeptSegmentIndex = -1;
  for (let index = firstSegmentIndex; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXTINF:")) continue;
    const duration = Number(lines[index].slice("#EXTINF:".length).split(",", 1)[0]);
    if (!Number.isFinite(duration) || duration < 0) return body;
    if (accumulatedDuration + duration > resumeOffset) {
      firstKeptSegmentIndex = index;
      break;
    }
    accumulatedDuration += duration;
    droppedSegments += 1;
  }

  if (!droppedSegments || firstKeptSegmentIndex === -1) return body;
  const mediaSequenceIndex = lines.findIndex((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  const originalMediaSequence = mediaSequenceIndex === -1
    ? 0
    : Number(lines[mediaSequenceIndex].slice("#EXT-X-MEDIA-SEQUENCE:".length));
  if (!Number.isInteger(originalMediaSequence) || originalMediaSequence < 0) return body;

  const trimmedLines = [
    ...lines.slice(0, firstSegmentIndex),
    ...lines.slice(firstKeptSegmentIndex),
  ].filter((line) => !line.startsWith("#EXT-X-START:"));
  const nextMediaSequence = originalMediaSequence + droppedSegments;
  const trimmedMediaSequenceIndex = trimmedLines.findIndex((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  if (trimmedMediaSequenceIndex === -1) {
    const nextSegmentIndex = trimmedLines.findIndex((line) => line.startsWith("#EXTINF:"));
    trimmedLines.splice(nextSegmentIndex, 0, `#EXT-X-MEDIA-SEQUENCE:${nextMediaSequence}`);
  } else {
    trimmedLines[trimmedMediaSequenceIndex] = `#EXT-X-MEDIA-SEQUENCE:${nextMediaSequence}`;
  }

  onTrim?.({ resumeOffset, droppedSegments, nextMediaSequence });
  const trimmed = trimmedLines.join("\n");
  return hadTrailingNewline && !trimmed.endsWith("\n") ? `${trimmed}\n` : trimmed;
}

export function rewritePlexHlsManifest(body, options = {}) {
  const rewritten = body.replace(/\/video\/:\/transcode\/universal\//g, "/api/plex/hls/");
  return trimPlexHlsResumePlaceholders(rewritten, options);
}
