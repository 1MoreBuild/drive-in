export function parseVTT(text) {
  const cues = [];
  const blocks = String(text).replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const match = block.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
    if (!match) continue;
    const start = +(match[1] || 0)*3600 + +match[2]*60 + +match[3] + +match[4]/1000;
    const end = +(match[5] || 0)*3600 + +match[6]*60 + +match[7] + +match[8]/1000;
    const lines = block.split("\n");
    const tsIdx = lines.findIndex((line) => line.includes("-->"));
    const content = lines.slice(tsIdx + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (content) cues.push({ start, end, text: content });
  }
  return cues.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function buildCueEndPrefix(cues) {
  const prefix = new Float64Array(cues.length);
  let maxEnd = 0;
  for (let index = 0; index < cues.length; index += 1) {
    maxEnd = Math.max(maxEnd, cues[index].end);
    prefix[index] = maxEnd;
  }
  return prefix;
}

function lastCueStartingBefore(cues, time) {
  let low = 0;
  let high = cues.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= time) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

export function findActiveCues(track, time) {
  const { cues, cueEndPrefix } = track;
  const active = [];
  let index = lastCueStartingBefore(cues, time);
  while (index >= 0 && cueEndPrefix[index] > time) {
    const cue = cues[index];
    if (cue.start <= time && cue.end > time) active.push(cue);
    index -= 1;
  }
  return active.reverse();
}
