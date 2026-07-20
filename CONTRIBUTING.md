# Contributing

## Setup

Drive-In requires Node.js 20.19 or newer, yt-dlp, FFmpeg, and Deno.

```bash
git clone https://github.com/1MoreBuild/drive-in.git
cd drive-in
cp .env.example .env
npm install
npm run dev
```

The Vite app runs at `http://localhost:5173`; the API server runs at `http://localhost:9090`.

## Making changes

- Use plain JavaScript ES modules and 2-space indentation.
- Keep dependencies and abstractions minimal.
- Keep CLI code independent from server packages.
- Do not commit `.env`, runtime databases, logs, caches, diagnostic reports, or `player/dist/`.
- Explain behavior changes and compatibility impact in the pull request.

Run the full automated check:

```bash
npm run check
```

Playback and proxy changes also need a manual test against the affected source type: `hls`, `direct`, `dash_split`, or `plex`. Confirm that the server starts, the player loads, seeking works, and audio/video remain synchronized.

## Bug reports

Include:

- Reproduction steps and the affected URL or source type
- Operating system and Node.js version
- `yt-dlp --version` and `ffmpeg -version`
- Relevant browser and server logs
- Whether the failure also occurs when running yt-dlp directly

Report security issues privately through [GitHub Security Advisories](https://github.com/1MoreBuild/drive-in/security/advisories/new), not a public issue.

## License

Contributions are licensed under the repository's [MIT License](LICENSE).
