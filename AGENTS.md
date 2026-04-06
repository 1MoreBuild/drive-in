# AGENTS.md

## Project overview

Drive-In is an in-car media player for Tesla vehicles. It bypasses Tesla's restriction of freezing `<video>` elements while driving by rendering video frames on `<canvas>` via [libmedia](https://github.com/zhaohappy/libmedia) (AVPlayer) — a WebAssembly + WebGL media player.

### Architecture

```
CLI / Discord / Phone
        │
        ▼  POST /api/play
   Express server (port 9090)
        │
        ├─ yt-dlp: resolve video URL, detect stream type
        │    ├─ HLS → proxy with m3u8 URL rewriting
        │    ├─ Direct (mp4) → raw stream proxy
        │    └─ DASH split (Bilibili/YouTube) → generate MPD + proxy segments
        │
        ├─ Plex integration (DASH transcode + http-proxy)
        │
        ├─ WebSocket → push play/pause/stop to player
        │
        └─ Static file server
             ├─ /lib/avplayer/* → libmedia ESM dist (from node_modules)
             └─ /* → player (dist/ in production, source in dev)

Tesla browser opens http://<server>/
        │
        └─ libmedia AVPlayer renders on <canvas> (not <video>)
```

### Stream types

| Type | Example | How it works |
|------|---------|-------------|
| `hls` | `.m3u8` URLs, some live streams | Proxy m3u8 + rewrite segment URLs for CORS |
| `direct` | `.mp4` with audio+video in one file | Raw stream proxy |
| `dash_split` | Bilibili, YouTube (separate video+audio) | Probe MP4 structure, generate MPD, proxy segments |
| `plex` | Plex library items | DASH transcode via Plex server, proxied with http-proxy |

## Workspace structure

```
drive-in/              (npm workspaces root)
├── server/            Express + WebSocket + yt-dlp + Plex + proxy
│   ├── index.js       Main server, all route/proxy/pipeline logic
│   └── logger.js      Pino logger setup
├── player/            Browser frontend (Vite build for prod, source for dev)
│   ├── index.html     Import map for @libmedia/avplayer
│   ├── vite.config.js Vite config for production build
│   ├── dist/          Production build output (vite build)
│   └── src/
│       ├── main.js    AVPlayer setup, WebSocket, audio unlock, controls
│       └── style.css  Fullscreen canvas layout, UI overlay
├── cli/               CLI tool
│   └── bin/drivein.js Commander-based CLI (play/pause/resume/stop/status/plex/subs)
├── skills/            Claude Code skill definitions
├── .hls-cache/        Temp HLS segments from ffmpeg (gitignored, auto-cleaned)
└── .play-history.json Play history (persisted, gitignored)
```

## Setup commands

```bash
npm install                     # install all workspaces
npm run dev                     # start server + Vite dev server + cloudflared tunnel
npm run build                   # build player only (Vite production build)
npm run start                   # build player + start server + cloudflared tunnel
npm run start -w server         # start server only (no tunnel)
SERVE_SOURCE=1 npm run dev      # dev mode — serve player source, no build needed
```

Open `http://localhost:9090` in a browser (or Tesla browser via Cloudflare Tunnel).

### Prerequisites

- **Node.js** >= 20
- **yt-dlp** — `brew install yt-dlp`
- **ffmpeg** — `brew install ffmpeg`
- **Deno** — `brew install deno` (required by yt-dlp for YouTube)
- **cloudflared** — `brew install cloudflared` (for tunnel access from Tesla)

### CLI usage

```bash
npx drivein play <url>          # play a video (YouTube, Bilibili, direct HLS/mp4)
npx drivein pause
npx drivein resume
npx drivein stop
npx drivein status
npx drivein subs                # list subtitles for current playback
npx drivein sub en zh           # enable English + Chinese subs
npx drivein plex movies         # list Plex movies
npx drivein plex shows          # list Plex TV shows
npx drivein plex search <query> # search Plex library
npx drivein plex play <id>      # play a Plex item by rating key
```

Set `DRIVEIN_SERVER` env var to point CLI at a remote server.

### Plex environment

- `PLEX_URL` — Plex server URL (default: `http://localhost:32400`)
- `PLEX_TOKEN` — Plex auth token (auto-detected from macOS defaults if not set)

## Code style

- ES modules (`"type": "module"` in all packages)
- No TypeScript, no transpiler — plain JS
- Player uses Vite for production build, served as source in dev mode
- Server dependencies: express, ws, http-proxy, pino, pino-http
- Player dependencies: @libmedia/avplayer
- CLI dependencies: commander

## Key technical details

- **COOP/COEP headers** are required — libmedia uses SharedArrayBuffer for WebAssembly workers. Server sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.
- **Player serving** — production: `player/dist/` (Vite build with hashed assets). Dev: `player/` source directly (`SERVE_SOURCE=1`).
- **Import map** in `index.html` maps `@libmedia/avplayer` to `/lib/avplayer/avplayer.js`.
- **Audio autoplay** — browsers require user gesture. Player starts muted and shows a mute icon; clicking anywhere unmutes.
- **HLS cache cleanup** — old session dirs are removed on startup and when playback stops.
- **Proxy map TTL** — registered proxy URLs expire after 1 hour.
- **Play history** — last 30 items persisted to `.play-history.json`, used for resume on replay.
- **Subtitles** — yt-dlp extracts subtitle URLs, server downloads and caches VTT/SRT files. Plex subtitles use burn-in via transcode.
- **DASH MPD generation** — for split video+audio streams (YouTube/Bilibili), server probes MP4 structure and generates a dynamic MPD manifest.
- **Plex DASH proxy** — uses `http-proxy` to forward Plex transcode streams with low overhead.

## Testing

No automated tests yet. Manual testing:

```bash
# HLS stream
curl -X POST http://localhost:9090/api/play \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"}'

# YouTube
curl -X POST http://localhost:9090/api/play \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}'

# Status
curl http://localhost:9090/api/status

# Plex
curl http://localhost:9090/api/plex/libraries
```

## CLI package

The CLI is published as [`@drive-in/cli`](https://www.npmjs.com/package/@drive-in/cli) on npm. It's a standalone HTTP client — no server dependencies, just sends requests to a running Drive-In server.

- **Package**: `@drive-in/cli` (npm, scoped under `@drive-in` org)
- **Binary name**: `drivein`
- **Config**: `~/.config/drivein/config.json` (persistent server URL via `drivein config set server <url>`)
- **Output modes**: `--json`, `--quiet`, `--no-color` (respects `NO_COLOR` env)
- **Exit codes**: 0=success, 1=failure, 2=usage, 3=empty, 4=auth, 5=not-found, 6=forbidden, 7=rate-limit, 8=connection

## Releasing

See [RELEASING.md](RELEASING.md) for full details. Summary:

```bash
npm version patch -w cli        # bump version in cli/package.json
git push && git push --tags     # push commit + tag
gh release create v<version> --generate-notes  # triggers npm publish via OIDC
```

The `release-cli.yml` GitHub Actions workflow publishes to npm automatically using OIDC trusted publishing (no `NPM_TOKEN` secret needed).

## CI/CD

- **CI** (`ci.yml`): runs on push/PR — `npm ci`, build player, smoke test server + CLI. Node 20 + 22.
- **Release** (`release-cli.yml`): triggered by GitHub Release — validates tag matches `cli/package.json` version, publishes to npm with OIDC + provenance.
- **Claude Code** (`claude.yml`, `claude-code-review.yml`): AI-assisted PR review and issue triage.
- **Dependabot** (`dependabot.yml`): weekly npm + GitHub Actions dependency updates.

## Security considerations

- WebSocket `updateState` only accepts the `status` field from player clients (sanitized).
- Proxy endpoints are open — intended for local/tunnel use only, not public internet.
- yt-dlp has a 30-second timeout to prevent hanging.
- yt-dlp uses `--cookies-from-browser chrome` to avoid rate limiting.
