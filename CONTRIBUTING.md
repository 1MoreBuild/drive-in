# Contributing to Drive-In

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js** >= 20
- **yt-dlp** — `brew install yt-dlp`
- **ffmpeg** — `brew install ffmpeg`
- **Deno** — `brew install deno` (required by yt-dlp for YouTube)
- **cloudflared** — `brew install cloudflared` (optional, for tunnel access)

### Getting Started

```bash
git clone https://github.com/1MoreBuild/drive-in.git
cd drive-in
cp .env.example .env          # configure environment variables
npm install                    # install all workspaces
SERVE_SOURCE=1 npm run dev     # start in dev mode (no build needed)
```

Open `http://localhost:9090` in a browser.

### Development Modes

| Command | Description |
|---------|-------------|
| `SERVE_SOURCE=1 npm run dev` | Dev mode — serves player source directly, hot reload |
| `npm run dev` | Dev mode with Vite dev server + Cloudflare Tunnel |
| `npm run build` | Build player and start production server + tunnel |
| `npm run start -w server` | Server only, no tunnel |

## Code Style

- **ES modules** — `"type": "module"` in all packages
- **Plain JavaScript** — no TypeScript, no transpiler
- **2-space indentation**, LF line endings
- Keep it simple — minimal abstractions, no unnecessary dependencies

## Project Structure

This is an npm workspaces monorepo:

- `server/` — Express server, WebSocket, yt-dlp integration, proxy logic
- `player/` — Browser frontend (Vite build for prod, source for dev)
- `cli/` — Commander-based CLI tool

## Making Changes

### Pull Request Process

1. Fork the repository and create a feature branch from `main`
2. Make your changes in the appropriate workspace(s)
3. Test manually (see below)
4. Submit a PR with a clear description of what changed and why
5. Link related issues if applicable

### Commit Messages

Use clear, descriptive commit messages:

- `Fix subtitle sync issue for Bilibili videos`
- `Add resolution selection for YouTube playback`
- `Refactor proxy URL handling for DASH streams`

### Manual Testing

There are no automated tests yet. Before submitting a PR, please verify:

- [ ] Server starts without errors (`npm run start -w server`)
- [ ] Player loads in browser at `http://localhost:9090`
- [ ] Your change works for the relevant stream type(s):

```bash
# HLS stream
curl -X POST http://localhost:9090/api/play \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"}'

# Status check
curl http://localhost:9090/api/status

# CLI
npx drivein status
```

## Issue Reporting

### Bug Reports

Include:
- Which workspace is affected (`server`, `player`, `cli`)
- OS and Node.js version
- yt-dlp and ffmpeg versions (`yt-dlp --version`, `ffmpeg -version`)
- Steps to reproduce
- Error logs (from terminal, not just browser console)

### Site Extraction Issues

If a video URL fails to play:
- Include the URL (or describe the site/format)
- Include `yt-dlp --version`
- Specify stream type if known (HLS, DASH, direct)
- Check if `yt-dlp -j <url>` works directly

## Good First Issues

Look for issues labeled [`good first issue`](https://github.com/1MoreBuild/drive-in/labels/good%20first%20issue). These are typically:

- Documentation improvements
- Small CLI enhancements
- UI polish fixes
- Adding support for a new subtitle format

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
