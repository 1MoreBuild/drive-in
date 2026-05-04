// --- VTT subtitle renderer -------------------------------------------

const subtitleOverlay = document.getElementById("subtitle-overlay");
let subtitleTracks = []; // [{ lang, cues }]
let lastRenderedSubtitle = "";

function clearSubtitleOverlay() {
  if (!lastRenderedSubtitle && !subtitleOverlay.hasChildNodes()) return;
  subtitleOverlay.replaceChildren();
  lastRenderedSubtitle = "";
}

function renderSubtitleLines(lines) {
  const nextRenderedSubtitle = lines.join("\n");
  if (nextRenderedSubtitle === lastRenderedSubtitle) return;

  lastRenderedSubtitle = nextRenderedSubtitle;
  if (!lines.length) {
    subtitleOverlay.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  lines.forEach((line, index) => {
    const span = document.createElement("span");
    span.textContent = line;
    fragment.append(span);
    if (index < lines.length - 1) {
      fragment.append(document.createElement("br"));
    }
  });
  subtitleOverlay.replaceChildren(fragment);
}

function binarySearchCue(cues, time) {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cue = cues[mid];
    if (time < cue.start) {
      high = mid - 1;
    } else if (time >= cue.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function findActiveCue(track, time) {
  const { cues } = track;
  if (!cues.length) return null;

  let index = track.cursor;
  const cachedCue = cues[index];

  // Cache the active cue index so subtitle rendering does not rescan the full track on every TIME event.
  if (
    track.lastTime === null
    || time < track.lastTime
    || !cachedCue
    || time < cachedCue.start
    || time >= cachedCue.end
  ) {
    index = binarySearchCue(cues, time);
  } else {
    while (index + 1 < cues.length && time >= cues[index].end) {
      index += 1;
    }
    if (time < cues[index].start || time >= cues[index].end) {
      index = binarySearchCue(cues, time);
    }
  }

  track.lastTime = time;
  track.cursor = index >= 0 ? index : (time < cues[0].start ? 0 : cues.length - 1);
  return index >= 0 ? cues[index] : null;
}

export function parseVTT(text) {
  const cues = [];
  const blocks = text.split(/\n\n+/);
  for (const block of blocks) {
    const match = block.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
    if (!match) continue;
    const start = +match[1]*3600 + +match[2]*60 + +match[3] + +match[4]/1000;
    const end = +match[5]*3600 + +match[6]*60 + +match[7] + +match[8]/1000;
    const lines = block.split("\n");
    const tsIdx = lines.findIndex((l) => l.includes("-->"));
    const content = lines.slice(tsIdx + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (content) {
      cues.push({
        start,
        end,
        text: content,
        displayText: content.replace(/\n/g, " "),
      });
    }
  }
  return cues;
}

export function renderSubtitle(time) {
  if (!subtitleTracks.length) {
    clearSubtitleOverlay();
    return;
  }

  const lines = [];
  for (const track of subtitleTracks) {
    const active = findActiveCue(track, time);
    if (active) lines.push(active.displayText);
  }
  renderSubtitleLines(lines);
}

export async function loadSubtitleTrack(lang, url) {
  try {
    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    const existingTrack = subtitleTracks.find((track) => track.lang === lang && track.url === absUrl);
    if (existingTrack) return;
    const resp = await fetch(absUrl);
    const text = await resp.text();
    const cues = parseVTT(text);
    subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
    // Store the current cue cursor with each track so subtitle lookup stays O(1) during steady playback.
    subtitleTracks.push({ lang, url: absUrl, cues, cursor: 0, lastTime: null });
    clearSubtitleOverlay();
    console.log(`[subs] Loaded ${cues.length} cues for ${lang}`);
  } catch (e) {
    console.error("[subs] Failed to load subtitle:", e);
  }
}

export function disableExternalSubtitle() {
  subtitleTracks = [];
  clearSubtitleOverlay();
}

export function removeSubtitleTrack(lang) {
  subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
  if (!subtitleTracks.length) {
    clearSubtitleOverlay();
    return;
  }
  lastRenderedSubtitle = "";
}
