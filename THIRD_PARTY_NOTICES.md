# Third-Party Notices

Drive-In depends on the following third-party software. Their licenses are listed below.

## Runtime Dependencies

### Mediabunny

- **License**: MPL-2.0
- **Source**: https://github.com/Vanilagy/mediabunny
- **Usage**: Browser media demuxing and WebCodecs decoding for canvas playback

Mediabunny is bundled with the player for production and loaded as an ES module in source-mode development. Modified MPL-covered files must remain available under MPL-2.0.

### yt-dlp

- **License**: Unlicense
- **Source**: https://github.com/yt-dlp/yt-dlp
- **Usage**: External CLI tool for resolving video URLs and extracting stream metadata

yt-dlp is invoked as a subprocess and is not bundled with this project. Users must install it separately.

### FFmpeg

- **License**: LGPL-2.1-or-later (default build), GPL-2.0-or-later (with `--enable-gpl`), or non-redistributable (with `--enable-nonfree`)
- **Source**: https://ffmpeg.org/
- **Usage**: External CLI tool used as a fallback for HLS remuxing

FFmpeg is invoked as a subprocess and is not bundled with this project. Users must install it separately. If you redistribute Docker images or binaries that include FFmpeg, verify the license of your FFmpeg build matches your distribution terms. See https://ffmpeg.org/legal.html for details.

### Deno

- **License**: MIT
- **Source**: https://github.com/denoland/deno
- **Usage**: Required by yt-dlp for YouTube nsig challenge solving (since yt-dlp 2025.11.12)

Deno is an external runtime and is not bundled with this project.

## Node.js Dependencies

All Node.js dependencies are listed in `package.json` files across the monorepo workspaces. Run `npm ls` to view the full dependency tree. Key dependencies include:

| Package | License | Usage |
|---------|---------|-------|
| express | MIT | HTTP server |
| ws | MIT | WebSocket server |
| http-proxy | MIT | Plex transcode proxy |
| pino | MIT | Logging |
| better-sqlite3 | MIT | Queue and playlist persistence |
| commander | MIT | CLI framework |
| mediabunny | MPL-2.0 | Media demuxing and WebCodecs decoding |
| vite | MIT | Player build tool (dev dependency) |
