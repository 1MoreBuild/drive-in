# Drive-In

In-car media player for Tesla vehicles. Renders video on `<canvas>` via WebAssembly to bypass Tesla's restriction of freezing `<video>` elements while driving.

> **Disclaimer**
>
> This project is an **educational and exploratory experiment** in human-vehicle interaction and in-car media experiences. It is not intended for production use or to encourage unsafe behavior.
>
> - **Drive safely.** Only use this software while the vehicle is parked or by passengers. Never operate a vehicle while distracted. Always obey local traffic laws.
> - **Respect copyright.** This project does not host, distribute, or encourage access to pirated or unauthorized content. Users are solely responsible for ensuring they have the legal right to access and play any media.
> - **No affiliation.** This project is not affiliated with, endorsed by, or associated with Tesla, Inc. or Plex, Inc.

## Features

- **YouTube / Bilibili / HLS / MP4** — play almost any video URL via yt-dlp
- **Plex integration** — browse and play your Plex library with subtitle and audio track selection
- **Canvas rendering** — WebAssembly + WebGL via [libmedia](https://github.com/zhaohappy/libmedia), works in Tesla browser while driving
- **Dual subtitles** — display two subtitle languages simultaneously
- **CLI control** — play, pause, stop, browse Plex, manage subtitles from the terminal
- **Remote access** — Cloudflare Tunnel support for controlling from outside the local network

## Architecture

```
CLI / Discord / Phone
        |
        v  POST /api/play
   Express server (port 9090)
        |
        +-- yt-dlp: resolve video URL, detect stream type
        |    +-- HLS -> proxy with m3u8 URL rewriting
        |    +-- Direct (mp4) -> raw stream proxy
        |    +-- DASH split (Bilibili/YouTube) -> generate MPD + proxy segments
        |
        +-- Plex integration (DASH transcode + http-proxy)
        |
        +-- WebSocket -> push play/pause/stop to player
        |
        +-- Static file server
             +-- /lib/avplayer/* -> libmedia ESM dist
             +-- /* -> player UI

Tesla browser opens http://<server>/
        |
        +-- libmedia AVPlayer renders on <canvas> (not <video>)
```

### Stream Types

| Type | Example | How it works |
|------|---------|-------------|
| `hls` | `.m3u8` URLs, live streams | Proxy m3u8 + rewrite segment URLs for CORS |
| `direct` | `.mp4` with audio+video | Raw stream proxy |
| `dash_split` | Bilibili, YouTube | Probe MP4 structure, generate MPD, proxy segments |
| `plex` | Plex library items | DASH transcode via Plex server, proxied |

## Prerequisites

- **Node.js** >= 20
- **yt-dlp** — `brew install yt-dlp`
- **ffmpeg** — `brew install ffmpeg`
- **Deno** — `brew install deno` (required by yt-dlp for YouTube)
- **cloudflared** — `brew install cloudflared` (optional, for remote access from Tesla)

## Quick Start

```bash
git clone https://github.com/1MoreBuild/drive-in.git
cd drive-in
cp .env.example .env          # configure environment variables (optional)
npm install                    # install all workspaces
npm run dev                    # start server + Cloudflare Tunnel
```

Open `http://localhost:9090` in a browser (or use the Cloudflare Tunnel URL on your Tesla).

### Other Modes

```bash
SERVE_SOURCE=1 npm run dev     # dev mode — serve player source, no Vite build
npm run build                  # build player only (Vite production build)
npm run start                  # build player + start server + Cloudflare Tunnel
npm run start -w server        # start server only (no tunnel, no build)
```

## Docker

```bash
docker build -t drive-in .
docker run -p 9090:9090 --env-file .env drive-in
```

Or with Docker Compose:

```bash
docker compose up
```

The image includes Node.js, yt-dlp, ffmpeg, and Deno. See [`docker-compose.yml`](docker-compose.yml) for optional Cloudflare Tunnel configuration.

## CLI

The CLI is published as [`@drive-in/cli`](https://www.npmjs.com/package/@drive-in/cli) on npm. Use it to control a running Drive-In server from anywhere.

```bash
# Install globally, or use npx
npx @drive-in/cli status

# Or if you cloned the repo, just use:
npx drivein status
```

### Configure server URL (once)

```bash
npx drivein config set server http://your-server:9090
```

Precedence: `--server` flag > `DRIVEIN_SERVER` env > config file > default (`localhost:9090`)

### Commands

```bash
npx drivein play <url>          # play a video (YouTube, Bilibili, HLS, mp4)
npx drivein pause               # pause playback
npx drivein resume              # resume playback
npx drivein stop                # stop playback
npx drivein status              # show current status

# Subtitles
npx drivein subs                # list available subtitles
npx drivein sub en zh           # enable English + Chinese subs

# Plex
npx drivein plex movies         # list Plex movies
npx drivein plex shows          # list Plex TV shows
npx drivein plex search <query> # search Plex library
npx drivein plex play <id>      # play a Plex item by rating key

# Output modes
npx drivein --json status       # JSON output for scripting
npx drivein --quiet play <url>  # suppress output (errors only)
npx drivein --no-color status   # disable colored output
```

## Plex Setup

1. Set `PLEX_URL` (default: `http://localhost:32400`) and `PLEX_TOKEN` in your `.env` file
2. On macOS, the Plex token is auto-detected from system defaults if not set
3. Browse and play:

```bash
npx drivein plex movies         # list movies
npx drivein plex play 12345     # play by rating key
```

## Tesla Browser Notes

- **SharedArrayBuffer** is required — the server sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` headers automatically
- **Audio autoplay** — the player starts muted due to browser restrictions; tap anywhere to unmute
- **Cloudflare Tunnel** is recommended for accessing the server from the Tesla browser — set up your own tunnel with `cloudflared tunnel`

## Project Structure

```
drive-in/              (npm workspaces monorepo)
+-- server/            Express + WebSocket + yt-dlp + Plex + proxy
|   +-- index.js       Main server, all route/proxy/pipeline logic
|   +-- logger.js      Pino logger setup
+-- player/            Browser frontend (Vite build for prod, source for dev)
|   +-- index.html     Import map for @libmedia/avplayer
|   +-- vite.config.js Vite config for production build
|   +-- src/
|       +-- main.js    AVPlayer setup, WebSocket, audio unlock, controls
|       +-- style.css  Fullscreen canvas layout, UI overlay
+-- cli/               CLI tool
|   +-- bin/drivein.js Commander-based CLI
+-- skills/            Claude Code skill definitions
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLEX_URL` | `http://localhost:32400` | Plex server URL |
| `PLEX_TOKEN` | (auto-detected on macOS) | Plex authentication token |
| `DRIVEIN_SERVER` | `http://localhost:9090` | CLI remote server URL |
| `SERVE_SOURCE` | — | Set to `1` for dev mode (serve player source) |

See [`.env.example`](.env.example) for a template.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and PR guidelines.

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT License](LICENSE)

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party dependency licenses. Notable: [@libmedia/avplayer](https://github.com/zhaohappy/libmedia) is LGPL-3.0.

---

*Not affiliated with Tesla, Inc. or Plex, Inc.*
