// --- VTT subtitle renderer -------------------------------------------

import { buildCueEndPrefix, parseVTT } from "./subtitle-cues.js";
import { activeSubtitleGroups } from "./subtitle-layout.js";
import { requestText } from "./network.js";

export { parseVTT } from "./subtitle-cues.js";

const subtitleOverlay = document.getElementById("subtitle-overlay");
let subtitleTracks = []; // [{ lang, cues }]
let lastRenderedSubtitle = "";

function clearSubtitleOverlay() {
  if (!lastRenderedSubtitle && !subtitleOverlay.hasChildNodes()) return;
  subtitleOverlay.replaceChildren();
  lastRenderedSubtitle = "";
}

function renderSubtitleGroups(groups) {
  const nextRenderedSubtitle = JSON.stringify(groups);
  if (nextRenderedSubtitle === lastRenderedSubtitle) return;

  lastRenderedSubtitle = nextRenderedSubtitle;
  if (!groups.length) {
    subtitleOverlay.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const track = document.createElement("div");
    track.className = "subtitle-track";
    track.lang = group.lang;
    track.dataset.lang = group.lang;
    for (const line of group.lines) {
      const lineElement = document.createElement("span");
      lineElement.className = "subtitle-line";
      lineElement.textContent = line;
      track.append(lineElement);
    }
    fragment.append(track);
  }
  subtitleOverlay.replaceChildren(fragment);
}

export function renderSubtitle(time) {
  if (!subtitleTracks.length) {
    clearSubtitleOverlay();
    return;
  }

  renderSubtitleGroups(activeSubtitleGroups(subtitleTracks, time));
}

export async function loadSubtitleTrack(lang, url) {
  try {
    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    const existingTrack = subtitleTracks.find((track) => track.lang === lang && track.url === absUrl);
    if (existingTrack) return;
    const resp = await requestText(absUrl, {}, {
      label: "Subtitle",
      timeoutMs: 20_000,
      maxBytes: 20 * 1024 * 1024,
    });
    if (!resp.ok) throw new Error(`Subtitle fetch failed with ${resp.status}`);
    const cues = parseVTT(resp.text);
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
