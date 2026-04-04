# Third-Party Notices

Drive-In depends on the following third-party software. Their licenses are listed below.

## Runtime Dependencies

### @libmedia/avplayer

- **License**: LGPL-3.0-or-later
- **Source**: https://github.com/zhaohappy/libmedia
- **Usage**: WebAssembly + WebGL media player used for canvas-based video rendering

This project dynamically loads `@libmedia/avplayer` as an ES module at runtime. Under the LGPL-3.0, you are free to use this library without affecting the license of your own code, provided that you do not modify the library itself. If you modify the library, you must release those modifications under the LGPL-3.0.

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
| commander | MIT | CLI framework |
| vite | MIT | Player build tool (dev dependency) |
