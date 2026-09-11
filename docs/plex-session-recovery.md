# Plex session recovery

## Incident

Plex reclaimed an idle HLS session after 180 seconds. Drive-In continued fetching
its segment URLs. Each upstream 404 triggered up to 15.75 seconds of retry delays,
longer than the browser's 12-second inactivity limit. The UI reported network
trouble while the upstream was actually returning immediate, definitive 404s.
A WebSocket reconnect skipped restoration whenever a local player existed.

## Community baseline

[python-plexapi](https://github.com/pkkid/python-plexapi/blob/master/plexapi/server.py)
uses `/transcode/sessions` for the active transcode inventory. We reuse that Plex
API, not an inferred timeout or a custom session lifetime. No Plex global setting
is changed. In particular, the transcoder throttle buffer is not a session lease.

## Boundaries

- `server/plex-session-health.js` owns inventory interpretation, shared bounded
  probes, typed expiration responses, and missing-segment retry budgets.
- `server/index.js` retains HTTP streaming, metrics, track selection, and the
  existing latest-wins playback coordinator. Proxies never restart playback.
- `HlsSegmentPrefetcher` stops requests for an expired playlist and preserves the
  typed error. A fresh playlist is independent of the old one.
- `MediabunnyPlayer` reports active-session expiration and defers background
  expiration while paused until play is requested.
- `player.js` remains the single owner of fresh-session recovery. Its existing
  request builder preserves position, selected tracks, and playback intent.
- `main.js` probes Plex on reconnect before reusing an existing local player.
  A stale response cannot restore over a replacement player or another route.

## Contract and budgets

- A missing manifest or segment plus a successful inventory proving absence
  returns HTTP 410, JSON `code: PLEX_SESSION_EXPIRED`, and the same code in
  `X-Drive-In-Error-Code`. Responses are not cached.
- An inaccessible or malformed inventory means `unknown`, not expired.
- Inventory requests are single-flight, bounded to two seconds, with a 250 ms
  shared snapshot. No per-session map grows with playback history.
  Publishing a new transcode invalidates both cached and in-flight old snapshots.
- Missing segments receive at most four attempts, with delays 0/250/500/1000 ms.
  The complete response-header negotiation (including probes) has an eight-second
  budget. Body transfers retain a separate six-second inactivity timeout.
- Client disconnect cancels segment requests and retry waits. An already-running
  shared inventory probe may finish within its own two-second limit.
- `GET /api/plex/session` returns `session`, `ratingKey`, and `health` without
  credentials. It is a read-only diagnostic, not a keepalive or restart endpoint.

## Verification

Unit tests cover missing/alive/unknown states, request sharing, cancellation,
budgets, and error propagation. HTTP tests distinguish missing sessions from
not-yet-generated segments. Browser tests use real HLS decoding and expire the
fixture session, checking fresh-session playback, track/position preservation,
paused deferral, and WebSocket reconnect while paused.

Live Plex and Tesla checks remain separate from fixture success. Existing open
browser pages need a reload to acquire updated client code.
