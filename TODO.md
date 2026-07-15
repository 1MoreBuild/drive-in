# Drive-In Development Notes

This file records current architecture constraints and unfinished work. Completed feature lists belong in Git history, not here.

## Architecture decisions

### Mediabunny canvas player

Tesla can freeze native `<video>` rendering while moving. Drive-In uses Mediabunny to demux media, WebCodecs to decode it, and Canvas 2D to present frames. An AudioWorklet sample counter is the master presentation clock.

The required browser features are:

- `VideoDecoder` and `AudioDecoder`
- `AudioContext` and `AudioWorkletNode`
- `SharedArrayBuffer`
- a cross-origin-isolated page

The server therefore sends:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

### Split video and audio

YouTube and Bilibili commonly return separate fragmented MP4 files. Drive-In parses their `sidx` tables, exposes byte ranges as session-scoped fMP4 HLS playlists, and prefetches upcoming segments into `.segment-cache/`.

Each playback gets its own `/api/dash/hls/:sessionId/...` URL. A reconnect or duplicate play request must not invalidate another active session.

Set `DASH_TRANSCODE=1` only when the ffmpeg fallback is needed. The default path preserves source quality without a local transcode.

### Plex

Plex performs HLS transcoding, codec conversion, audio selection, and image-subtitle burn-in. Drive-In rewrites and proxies Plex playlists and segments so the browser sees one origin. Text subtitles are converted and cached as WebVTT, then rendered by the browser. Conversion failures fall back to Plex burn-in.

### Persistent state

- `.play-history.json` stores the latest 30 playback entries.
- `.drive-in.sqlite` stores Up Next and saved playlists.
- `.media-cache/` stores source subtitles, converted Plex subtitles, and thumbnails.
- `.segment-cache/` stores split-stream byte ranges with a size-bounded LRU policy.
- `.hls-cache/` stores temporary ffmpeg fallback sessions and is cleared on startup.

## Operational constraints

- The player requires a user gesture before audio can be unmuted.
- Public HTTP APIs and WebSocket control are unauthenticated. Put public deployments behind Cloudflare Access, a VPN, or another trusted access layer.
- yt-dlp extraction changes frequently. Keep yt-dlp and Deno current.
- CDN URLs expire. Proxy entries retain the original page URL so the server can re-resolve media URLs after an upstream failure.
- External thumbnails must use `/api/thumb` or `/api/plex/thumb`; COEP can block direct cross-origin images.

## Current API map

### Playback and state

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/play` | Resolve and play a URL |
| POST | `/api/control` | Pause, resume, or stop |
| GET | `/api/status` | Current server and player state |
| GET/DELETE | `/api/history` | Read or clear play history |

### Queue and playlists

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET/POST/DELETE | `/api/queue` | List, add, or clear Up Next |
| POST | `/api/queue/next` | Play the next queued item |
| POST | `/api/queue/reorder` | Reorder Up Next |
| POST | `/api/queue/:id/play` | Play a queued item |
| DELETE | `/api/queue/:id` | Remove a queued item |
| GET/POST | `/api/playlists` | List or create playlists |
| GET/PATCH/DELETE | `/api/playlists/:id` | Read, update, or delete a playlist |
| POST | `/api/playlists/:id/items` | Add a playlist item |
| DELETE | `/api/playlists/:id/items/:itemId` | Remove a playlist item |
| POST | `/api/playlists/:id/enqueue` | Add a playlist to Up Next |

### Media delivery

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/proxy?id=` | Direct stream and byte-range proxy |
| GET | `/api/proxy/hls?id=` | HLS manifest and segment proxy |
| GET | `/api/dash/hls/:sessionId/:playlist` | Generated split-stream HLS playlists |
| GET | `/api/dash/:mapId/:segment` | Generated init and media segments |
| GET | `/api/transcode/playlist.m3u8` | Optional ffmpeg fallback playlist |
| GET | `/api/transcode/segment?name=` | Optional ffmpeg fallback segment |

### Diagnostics

| URL | Purpose |
|-----|---------|
| `/diag.html` | Browser capability report |
| `/metrics.html` | Live proxy and player metrics |
| `/api/health` | Process health and connection counts |
| `/api/dev/player` | Last player state reported over WebSocket |

## Roadmap

1. Add automated tests for playlist rewriting, `sidx` parsing, queue persistence, and route isolation.
2. Run long-duration Tesla tests across Bilibili, YouTube, HLS, and Plex.
3. Add source-quality selection without using resolution reduction as a synchronization workaround.
4. Add authenticated phone controls and explicit device pairing.
5. Add Bilibili danmaku rendering only after playback reliability is stable.
