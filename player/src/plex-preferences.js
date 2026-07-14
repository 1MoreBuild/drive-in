export function plexPlaybackRequest(ratingKey, extra = {}) {
  let preferredSubtitleLanguages = [];
  let preferredAudioLanguage = null;
  let estimatedThroughputKbps = null;

  try {
    const stored = JSON.parse(localStorage.getItem("preferred-sub-langs") || "[]");
    if (Array.isArray(stored)) preferredSubtitleLanguages = stored.map(String);
  } catch {}

  try {
    preferredAudioLanguage = localStorage.getItem("preferred-audio-lang") || null;
  } catch {}

  try {
    const estimate = JSON.parse(localStorage.getItem("drivein-plex-abr-estimate") || "null");
    const ageMs = Date.now() - Number(estimate?.updatedAt);
    const throughputKbps = Number(estimate?.throughputKbps);
    if (ageMs >= 0 && ageMs <= 6 * 60 * 60 * 1000 && Number.isFinite(throughputKbps) && throughputKbps > 0) {
      estimatedThroughputKbps = throughputKbps;
    }
  } catch {}

  return {
    ratingKey,
    ...extra,
    ...(preferredSubtitleLanguages.length ? { preferredSubtitleLanguages } : {}),
    ...(preferredAudioLanguage ? { preferredAudioLanguage } : {}),
    ...(estimatedThroughputKbps ? { estimatedThroughputKbps } : {}),
  };
}

export async function requestPlexPlayback(payload) {
  const response = await fetch(`${location.origin}/api/plex/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Plex playback failed with ${response.status}`);
  }
  return result;
}
