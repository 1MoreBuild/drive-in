export function plexPlaybackRequest(ratingKey, extra = {}, { storage = globalThis.localStorage } = {}) {
  let preferredSubtitleLanguages = [];
  let preferredAudioLanguage = null;

  try {
    const stored = JSON.parse(storage?.getItem("preferred-sub-langs") || "[]");
    if (Array.isArray(stored)) preferredSubtitleLanguages = stored.map(String);
  } catch {}

  try {
    preferredAudioLanguage = storage?.getItem("preferred-audio-lang") || null;
  } catch {}

  return {
    ratingKey,
    ...extra,
    ...(preferredSubtitleLanguages.length ? { preferredSubtitleLanguages } : {}),
    ...(preferredAudioLanguage ? { preferredAudioLanguage } : {}),
  };
}

export async function requestPlexPlayback(payload, {
  origin = globalThis.location?.origin,
  fetchFn = globalThis.fetch,
} = {}) {
  const response = await requestJson(`${origin}/api/plex/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, { label: "Plex playback", timeoutMs: 90_000, fetchFn });
  const result = response.data || {};
  if (!response.ok) {
    throw new Error(result.error || `Plex playback failed with ${response.status}`);
  }
  return result;
}
import { requestJson } from "./network.js";
