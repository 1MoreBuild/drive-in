import { setTimeout as delay } from "node:timers/promises";
import { fetchTextWithRetry, openUpstreamStream } from "./upstream-fetch.js";

export const PLEX_SESSION_EXPIRED = "PLEX_SESSION_EXPIRED";

export function plexSessionId(path) {
  return /\/session\/([^/?]+)\//.exec(path)?.[1] || null;
}

// Use Plex's transcode inventory (also used by python-plexapi). A failed or
// malformed inventory is unknown, not proof that the user's session expired.
export function sessionHealth(data, session) {
  const container = data?.MediaContainer;
  if (!session || !container) return "unknown";
  const sessions = container.TranscodeSession;
  if (!Array.isArray(sessions)) return container.size === 0 ? "expired" : "unknown";
  if (sessions.some((entry) => entry.key === session
    || entry.key === `/transcode/sessions/${session}`)) return "alive";
  if (sessions.some((entry) => typeof entry.key !== "string")) return "unknown";
  return "expired";
}

export function createPlexSessionProbe({ baseUrl, token, fetchFn = globalThis.fetch }) {
  let snapshot = null;
  let expiresAt = 0;
  let pending = null;
  let generation = 0;
  const probe = async (session) => {
    if (!session) return "unknown";
    if (!pending && Date.now() >= expiresAt) {
      const requestGeneration = generation;
      pending = (async () => {
        let data = null;
        try {
          const result = await fetchTextWithRetry(`${baseUrl}/transcode/sessions`, {
            headers: { Accept: "application/json", "X-Plex-Token": token },
          }, { retries: 0, timeoutMs: 2000, responseTimeoutMs: 2000, fetchFn, label: "plex-session-health" });
          data = result.response.ok ? JSON.parse(result.body) : null;
        } catch {}
        if (requestGeneration === generation) {
          snapshot = data;
          expiresAt = Date.now() + 250;
        }
      })().finally(() => { pending = null; });
    }
    if (pending) await pending;
    return sessionHealth(snapshot, session);
  };
  // A snapshot taken before creation cannot prove the new session is absent.
  probe.invalidate = () => { generation++; snapshot = null; expiresAt = 0; };
  return probe;
}

export function expiredSessionResponse() {
  return Response.json({ code: PLEX_SESSION_EXPIRED, error: "Plex playback session expired" }, {
    status: 410,
    headers: { "X-Drive-In-Error-Code": PLEX_SESSION_EXPIRED, "Cache-Control": "no-store" },
  });
}

function probeWithinBudget(probe, session, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => probe(session)).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Own only missing-segment retries here. Header negotiation has an 8s total
// budget, below the browser's 12s inactivity timeout. Successful bodies keep
// their separate inactivity timeout; a slow but progressing transfer is valid.
export async function openPlexSegment(url, { signal, headers, probe, session,
  retryDelaysMs = [0, 250, 500, 1000], budgetMs = 8000,
  openStream = openUpstreamStream,
} = {}) {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new Error("Plex segment response budget exceeded")), budgetMs);
  const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  try {
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      combined.throwIfAborted();
      if (retryDelaysMs[attempt]) await delay(retryDelaysMs[attempt], undefined, { signal: combined });
      const stream = await openStream(url, { headers, signal: combined }, {
        label: "plex-hls-segment", responseTimeoutMs: budgetMs, inactivityTimeoutMs: 6000,
      });
      if (stream.response.status !== 404) return stream;
      await stream.response.body?.cancel().catch(() => {});
      stream.cleanup();
      const health = await probeWithinBudget(probe, session, combined);
      combined.throwIfAborted();
      if (health === "expired") return { response: expiredSessionResponse(), cleanup() {}, touch() {} };
      if (attempt === retryDelaysMs.length - 1) {
        return { response: new Response(null, { status: 404 }), cleanup() {}, touch() {} };
      }
    }
  } finally { clearTimeout(timer); }
}
