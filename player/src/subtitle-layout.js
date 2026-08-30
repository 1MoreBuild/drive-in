import { findActiveCues } from "./subtitle-cues.js";

export function activeSubtitleGroups(tracks, time) {
  const groups = [];
  for (const track of tracks) {
    const lines = [];
    const activeCues = findActiveCues(track, time);
    for (const cue of activeCues) {
      lines.push(...cue.text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean));
    }
    if (lines.length) groups.push({ lang: track.lang, lines });
  }
  return groups;
}
