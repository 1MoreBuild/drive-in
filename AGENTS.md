# AGENTS.md

## Project

Drive-In is a media player for Tesla browsers. It uses Mediabunny and WebCodecs to decode media, then renders frames to `<canvas>` because Tesla can freeze native `<video>` rendering while the vehicle is moving.

This is an npm workspaces repository:

- `server/` — Express, WebSocket control, yt-dlp, stream proxies, Plex, queues
- `player/` — Vite browser app and Mediabunny playback engine
- `cli/` — published `@drive-in/cli` HTTP client
- `skills/drive-in/` — agent instructions for operating a running server

## Commands

```bash
npm install
npm run dev                    # server :9090 + Vite :5173
npm run check                  # all tests + production player build
npm run start                  # build and serve production app on :9090
SERVE_SOURCE=1 npm run dev:server
```

Node.js 20.19 or newer is required. Playback also needs `yt-dlp`, `ffmpeg`, and Deno. Cloudflared is optional.

## Code map

- `server/index.js` owns routes, proxying, stream resolution, ffmpeg fallback, Plex playback, WebSocket state, and process lifecycle.
- `server/queue-store.js` owns SQLite queue and playlist persistence.
- `server/plex-subtitles.js` owns Plex subtitle classification, conversion, and caching.
- `server/plex-quality.js` owns the fixed Plex 720p playback profile.
- `server/stream-quality.js` owns viewport-based yt-dlp format selection.
- `server/security.js` owns safe cache-path resolution and external thumbnail fetching.
- `server/playback-coordinator.js` makes server playback transitions latest-wins.
- `server/history-store.js` owns atomic play-history persistence.
- `server/ws-protocol.js` validates player WebSocket messages.
- `player/src/main.js` owns routing and WebSocket connection lifecycle.
- `player/src/player.js` owns playback lifecycle, recovery, progress, and telemetry.
- `player/src/playback-generation.js` prevents stale play/stop transitions from mutating current playback.
- `player/src/engine/` owns decoding, audio buffering, presentation timing, and HLS prefetch.
- `cli/bin/drivein.js` is a standalone client and must not depend on server packages.

## Implementation constraints

- Use plain JavaScript ES modules and 2-space indentation. Do not add TypeScript or a transpiler.
- Keep `<canvas>` rendering. Replacing it with `<video>` breaks the core Tesla use case.
- COOP/COEP headers are required for the SharedArrayBuffer audio ring buffer.
- Production serves `player/dist/`; source mode serves `player/` and its Mediabunny import map.
- Audio starts muted until a user gesture unlocks the browser audio context.
- Keep decoded video queues memory-bounded. Network jitter belongs in encoded segment buffering, not a large canvas queue.
- HLS prefetch is single-flight so background buffering does not compete with foreground playback.
- Viewport quality changes must preserve playback position.
- Text subtitles are rendered in the browser; Plex image subtitles use burn-in.
- HTTP APIs, WebSocket control, and proxy routes have no built-in authentication. Do not describe a public tunnel as safe without an access layer.
- Runtime state belongs in ignored paths: `.drive-in.sqlite`, `.play-history.json`, `.hls-cache/`, `.media-cache/`, `.segment-cache/`, `.logs/`, and `.diag-reports/`.

Configuration belongs in environment variables documented by `.env.example`. Do not commit local tokens, databases, logs, caches, diagnostic reports, or built `player/dist/` files.

## Verification

Run `npm run check` for every code change. For route or playback changes, also verify the relevant stream type manually: `hls`, `direct`, `dash_split`, or `plex`.

When testing server startup, do not launch a second instance against the same repository while another instance is playing: startup clears stale `.hls-cache` sessions.
