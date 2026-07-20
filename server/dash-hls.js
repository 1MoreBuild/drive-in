export function parseMp4Structure(buffer, totalSize = 0) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let initEnd = 0;
  let sidxOffset = -1;
  let position = 0;

  while (position <= buf.length - 8) {
    const size = buf.readUInt32BE(position);
    if (size < 8 || position + size > buf.length) break;
    const type = buf.toString("ascii", position + 4, position + 8);
    if (type === "moov") initEnd = position + size - 1;
    else if (type === "sidx") sidxOffset = position;
    else if (type === "mdat") break;
    position += size;
  }

  const segments = [];
  let timescale = 1000;
  if (sidxOffset >= 0 && sidxOffset + 32 <= buf.length) {
    const sidxSize = buf.readUInt32BE(sidxOffset);
    const version = buf[sidxOffset + 8];
    let offset = sidxOffset + 12;
    offset += 4;
    timescale = buf.readUInt32BE(offset);
    offset += 4;
    if (!timescale) return { initEnd, segments, totalSize, timescale: 1000 };

    let firstOffset = 0;
    if (version === 0) {
      if (offset + 8 > buf.length) return { initEnd, segments, totalSize, timescale };
      offset += 4;
      firstOffset = buf.readUInt32BE(offset);
      offset += 4;
    } else if (version === 1) {
      if (offset + 16 > buf.length) return { initEnd, segments, totalSize, timescale };
      offset += 8;
      firstOffset = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    } else {
      return { initEnd, segments, totalSize, timescale };
    }
    if (offset + 4 > buf.length) return { initEnd, segments, totalSize, timescale };
    offset += 2;
    const referenceCount = buf.readUInt16BE(offset);
    offset += 2;

    let segmentStart = sidxOffset + sidxSize + firstOffset;
    for (let index = 0; index < referenceCount && offset + 12 <= buf.length; index += 1) {
      const firstWord = buf.readUInt32BE(offset);
      if (firstWord >>> 31) break;
      const referencedSize = firstWord & 0x7fffffff;
      const durationTicks = buf.readUInt32BE(offset + 4);
      if (!referencedSize) break;
      segments.push({
        start: segmentStart,
        end: segmentStart + referencedSize - 1,
        duration: durationTicks / timescale,
        durationTicks,
      });
      segmentStart += referencedSize;
      offset += 12;
    }
  }
  return { initEnd, segments, totalSize, timescale };
}

function mediaPlaylist(mapId, segments) {
  const targetDuration = Math.max(1, Math.ceil(Math.max(...segments.map((segment) => segment.duration))));
  const body = segments.flatMap((segment, index) => [
    `#EXTINF:${segment.duration.toFixed(6)},`,
    `/api/dash/${mapId}/${index}.mp4`,
  ]).join("\n");
  return `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="/api/dash/${mapId}/init.mp4"
${body}
#EXT-X-ENDLIST
`;
}

export function buildDashHlsSession({
  sessionId,
  videoFormat,
  audioFormat,
  videoProxyId,
  audioProxyId,
  videoInfo,
  audioInfo,
}) {
  if (!videoInfo?.segments?.length || !audioInfo?.segments?.length) return null;
  const videoMapId = `seg-${videoProxyId}`;
  const audioMapId = `seg-${audioProxyId}`;
  const videoCodec = videoFormat.vcodec || "avc1.640028";
  const audioCodec = audioFormat.acodec || "mp4a.40.2";
  const videoBandwidth = Math.round((videoFormat.tbr || 2000) * 1000);
  const audioBandwidth = Math.round((audioFormat.tbr || 128) * 1000);
  const width = videoFormat.width || 1280;
  const height = videoFormat.height || 720;
  const fps = videoFormat.fps || 30;
  const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="/api/dash/hls/${sessionId}/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=${videoBandwidth + audioBandwidth},RESOLUTION=${width}x${height},FRAME-RATE=${fps},CODECS="${videoCodec},${audioCodec}",AUDIO="audio"
/api/dash/hls/${sessionId}/video.m3u8
`;
  return {
    master,
    video: mediaPlaylist(videoMapId, videoInfo.segments),
    audio: mediaPlaylist(audioMapId, audioInfo.segments),
    videoMapId,
    audioMapId,
  };
}
