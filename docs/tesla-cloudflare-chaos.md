# Tesla and Cloudflare chaos check

Use this after playback or networking changes. `npm run test:e2e` validates the local HTTP/WebSocket playback journey and rewind cache reuse. This checklist covers what local automation cannot reproduce: the real Tesla renderer, mobile connection, Cloudflare path, and launchd service together.

## Before testing

1. Start a fixed 720p60 YouTube or Bilibili video through the public Drive-In URL.
2. Open `/metrics.html` on a second device. Keep `/api/metrics` and `/api/dev/player-log` available for raw evidence.
3. Record the playback position, buffered seconds, cached bytes, throughput, retry count, timeout count, and playback session ID.

## Faults

Run each fault separately and let playback become stable again before the next one.

| Fault | Expected result |
| --- | --- |
| Disconnect the car for 30 seconds | Cached video continues when possible. Recovery retries without a reload and resumes near the prior position. |
| Disconnect for 60 seconds | The UI explains measured insufficient bandwidth or an unstable connection. Retry delay stays capped at 60 seconds. |
| Disconnect for 180 seconds | The page remains responsive. Memory and pending-request counts stay bounded. Playback re-resolves the original source after connectivity returns. |
| Switch Wi-Fi to LTE or another hotspot | Old CDN/session URLs are discarded. A fresh `/api/play` or `/api/plex/play` session resumes at the saved position. |
| Restart the launchd server while playing | WebSocket reconnects. The player creates a fresh stream session instead of retrying the stale HLS URL forever. |

## Pass criteria

- No infinite `buffering`, `disconnect`, or `reconnect` state.
- No automatic quality increase or decrease; selected quality stays fixed.
- No retry storm: playback recovery follows 1, 3, 10, 30, then 60 second delays.
- HLS pending work drains after recovery; active downloads stay at one.
- Player logs contain `stall_start`, recovery scheduling, a fresh playback request, and `playback_recovery_stable`.
- A bandwidth warning only claims insufficient Mbps when at least two throughput samples support it.
