# Drive-In

Drive-In is a self-hosted media player for Tesla browsers. Mediabunny decodes media with WebCodecs and renders frames to `<canvas>` instead of a native `<video>` element.

> Use Drive-In only while parked or as a passenger. Obey local laws and only play media you are authorized to access. This project is not affiliated with Tesla or Plex.

## Features

- YouTube, Bilibili, HLS, and direct MP4 playback through yt-dlp
- Plex browsing and fixed 720p playback with track selection
- Canvas rendering with synchronized AudioWorklet playback
- Dual browser-rendered subtitles
- Queue, saved playlists, resume history, and CLI control
- Optional Cloudflare Tunnel access

## How it works

The browser sends playback requests to an Express server. The server resolves source URLs, proxies media through the same origin, and pushes player commands over WebSocket.

| Source | Delivery path |
|--------|---------------|
| HLS | Rewritten same-origin manifest and segment proxy |
| MP4 | Range-capable stream proxy |
| Split video/audio | Generated fMP4 HLS over source byte ranges |
| Plex | Proxied fixed 720p HLS transcode |

The player decodes these streams with Mediabunny and WebCodecs, uses consumed AudioWorklet samples as its clock, and presents video frames on a canvas.

## Requirements

- Node.js 22.12 or newer
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg](https://ffmpeg.org/)
- [Deno](https://deno.com/) for current YouTube extraction
- Cloudflared only if using a tunnel

On macOS:

```bash
brew install yt-dlp ffmpeg deno
```

## Run locally

```bash
git clone https://github.com/1MoreBuild/drive-in.git
cd drive-in
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. For the production build:

```bash
npm run start
```

Then open `http://localhost:9090`.

Other useful commands:

```bash
npm run dev:remote             # development with a temporary tunnel
npm run start:tunnel           # production with a configured tunnel
npm run check                  # tests and production build
```

## CLI

The published CLI controls a running Drive-In server:

```bash
npx @drive-in/cli config set server http://your-server:9090
npx @drive-in/cli play "https://www.youtube.com/watch?v=..."
npx @drive-in/cli pause
npx @drive-in/cli status
```

It also supports Plex, subtitles, audio tracks, queues, and playlists. Run `npx @drive-in/cli --help` for the current command list.

## Plex

Set `PLEX_URL` and `PLEX_TOKEN` in `.env`. On macOS, Drive-In can auto-detect a local Plex token when `PLEX_TOKEN` is unset.

Plex transcodes video once at 720p and does not change bitrate during playback. This keeps the 210-second prefetch buffer intact. Plex also handles image-subtitle burn-in; Drive-In converts supported text subtitles to WebVTT and renders them in the browser.

## Tesla and remote access

The server sets the cross-origin isolation headers required by its SharedArrayBuffer audio path. The first tap unlocks audio because browsers block autoplay with sound.

Drive-In does not authenticate HTTP, WebSocket, or proxy requests. Never expose it directly to the public internet. Put tunnels behind Cloudflare Access, a VPN, or another trusted access layer.

## Docker

```bash
docker build -t drive-in .
docker run -p 9090:9090 --env-file .env drive-in
```

Or:

```bash
cp .env.example .env
docker compose up
```

## Configuration

Copy [`.env.example`](.env.example) and edit the values you need. It documents Plex, bitrate, cache, port, logging, database, font, and fallback-transcode settings.

CLI server selection follows this order: `--server`, `DRIVEIN_SERVER`, the CLI config file, then `http://localhost:9090`.

## Diagnostics

- `/diag.html` checks required browser capabilities.
- `/metrics.html` shows current delivery and player health metrics.
- `/api/health` reports process and connection health.

## Development

Run `npm run check` before submitting changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for the short contribution guide and [RELEASING.md](RELEASING.md) for CLI releases.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
