// --- VTT subtitle renderer -------------------------------------------

import { buildCueEndPrefix, findActiveCues, parseVTT } from "./subtitle-cues.js";

export { parseVTT } from "./subtitle-cues.js";

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

export function renderSubtitle(time) {
  if (!subtitleTracks.length) {
    clearSubtitleOverlay();
    return;
  }

  const lines = [];
  for (const track of subtitleTracks) {
    const activeCues = findActiveCues(track, time);
    for (const cue of activeCues) lines.push(...cue.text.split("\n").filter(Boolean));
  }
  renderSubtitleLines(lines);
}

export async function loadSubtitleTrack(lang, url) {
  try {
    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    const existingTrack = subtitleTracks.find((track) => track.lang === lang && track.url === absUrl);
    if (existingTrack) return;
    const resp = await fetch(absUrl);
    if (!resp.ok) throw new Error(`Subtitle fetch failed with ${resp.status}`);
    const text = await resp.text();
    const cues = parseVTT(text);
    subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
    // Prefix maxima let lookup stop as soon as no earlier overlapping cue can still be active.
    subtitleTracks.push({ lang, url: absUrl, cues, cueEndPrefix: buildCueEndPrefix(cues) });
    clearSubtitleOverlay();
    console.log(`[subs] Loaded ${cues.length} cues for ${lang}`);
    return true;
  } catch (e) {
    console.error("[subs] Failed to load subtitle:", e);
    return false;
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
