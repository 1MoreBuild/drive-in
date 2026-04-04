// --- VTT subtitle renderer -------------------------------------------

const subtitleOverlay = document.getElementById("subtitle-overlay");
let subtitleTracks = []; // [{ lang, cues }]

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
    if (content) cues.push({ start, end, text: content });
  }
  return cues;
}

export function renderSubtitle(time) {
  if (!subtitleTracks.length) {
    subtitleOverlay.innerHTML = "";
    return;
  }
  const lines = [];
  for (const track of subtitleTracks) {
    const active = track.cues.find((c) => time >= c.start && time < c.end);
    if (active) lines.push(active.text.replace(/\n/g, " "));
  }
  const html = lines.length ? lines.map((l) => `<span>${l}</span>`).join("<br>") : "";
  if (subtitleOverlay.innerHTML !== html) subtitleOverlay.innerHTML = html;
}

export async function loadSubtitleTrack(lang, url) {
  try {
    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    const resp = await fetch(absUrl);
    const text = await resp.text();
    const cues = parseVTT(text);
    subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
    subtitleTracks.push({ lang, cues });
    console.log(`[subs] Loaded ${cues.length} cues for ${lang}`);
  } catch (e) {
    console.error("[subs] Failed to load subtitle:", e);
  }
}

export function disableExternalSubtitle() {
  subtitleTracks = [];
  subtitleOverlay.innerHTML = "";
}

export function removeSubtitleTrack(lang) {
  subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
  if (!subtitleTracks.length) subtitleOverlay.innerHTML = "";
}
