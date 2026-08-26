function srtToVtt(srt) {
  return "WEBVTT\n\n" + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}

function pickSubtitleFormat(formats = []) {
  const vtt = formats.find((format) => format.ext === "vtt" && format.url);
  const srt = formats.find((format) => (
    format.ext === "srt" && (format.url || format.data)
  ));
  return vtt || srt || formats.find((format) => format.data);
}

function subtitleEntry(lang, pick, { auto }) {
  return {
    lang,
    name: `${pick.name || lang}${auto ? " (auto)" : ""}`,
    auto,
    url: pick.url || null,
    data: pick.data
      ? (pick.ext === "srt" ? srtToVtt(pick.data) : pick.data)
      : null,
    ext: pick.ext,
  };
}

export function extractSubtitles(info = {}) {
  const subtitles = [];
  const manualLangs = new Set();

  for (const [lang, formats] of Object.entries(info.subtitles || {})) {
    if (lang === "danmaku") continue;
    const pick = pickSubtitleFormat(formats);
    if (!pick) continue;
    manualLangs.add(lang);
    subtitles.push(subtitleEntry(lang, pick, { auto: false }));
  }

  for (const [lang, formats] of Object.entries(info.automatic_captions || {})) {
    const pick = pickSubtitleFormat(formats);
    if (!pick) continue;
    const key = manualLangs.has(lang) ? `${lang}-auto` : lang;
    subtitles.push(subtitleEntry(key, pick, { auto: true }));
  }

  return subtitles;
}

export function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "youtu.be"
      || host === "youtube.com"
      || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

export function hasEnglishAndChineseSubtitles(subtitles = []) {
  const bases = new Set(subtitles.map((subtitle) => (
    String(subtitle.lang || "").split("-")[0].toLowerCase()
  )));
  return bases.has("en") && bases.has("zh");
}

export function mergeSubtitles(primary = [], fallback = []) {
  const merged = [...primary];
  const languages = new Set(primary.map((subtitle) => subtitle.lang));
  for (const subtitle of fallback) {
    if (languages.has(subtitle.lang)) continue;
    merged.push(subtitle);
    languages.add(subtitle.lang);
  }
  return merged;
}
