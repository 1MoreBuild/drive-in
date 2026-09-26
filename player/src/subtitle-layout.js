import { findActiveCues } from "./subtitle-cues.js";

// Track IDs (e.g. plex:80803) are identities, never valid language tags.
// Inspect each displayed line because a single ASS/VTT track can be bilingual.
export function subtitleLineLanguage(text, language = "") {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko";
  if (/\p{Script=Han}/u.test(text)) {
    if (/^(ja|jpn)$/i.test(language)) return "ja";
    if (/^(zh-(Hant|TW|HK)|yue)$/i.test(language)) return "zh-Hant";
    return "zh-Hans";
  }
  if (/\p{Script=Latin}/u.test(text)) return "en";
  return /^(en|zh(?:-(?:Hans|Hant|CN|TW|HK))?|ja|ko)$/i.test(language) ? language : "und";
}

export function subtitleDisplayLines(text) {
  // Keep authored language boundaries, but do not turn every dialogue dash
  // into a new row: a bilingual two-speaker cue would become four rows.
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function subtitlePictureBounds(width, height, videoWidth, videoHeight) {
  const scale = videoWidth > 0 && videoHeight > 0
    ? Math.min(width / videoWidth, height / videoHeight) : 1;
  const pictureWidth = videoWidth > 0 && videoHeight > 0 ? videoWidth * scale : width;
  const pictureHeight = videoWidth > 0 && videoHeight > 0 ? videoHeight * scale : height;
  return { width: pictureWidth, height: pictureHeight,
    bottom: (height - pictureHeight) / 2,
  };
}

export function activeSubtitleGroups(tracks, time) {
  const groups = [];
  for (const track of tracks) {
    const lines = [];
    const activeCues = findActiveCues(track, time);
    for (const cue of activeCues) {
      lines.push(...subtitleDisplayLines(cue.text));
    }
    if (lines.length) groups.push({ lang: track.lang, lines });
  }
  return groups;
}
