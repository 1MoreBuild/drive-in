# Drive-In Development Notes

## Architecture Decisions

### Why Mediabunny instead of native `<video>`?
Tesla freezes `<video>` element rendering while driving. Mediabunny exposes decoded WebCodecs frames that Drive-In presents on `<canvas>`, while an AudioWorklet sample counter provides the master A/V clock.

### Why fMP4 HLS for YouTube/Bilibili split streams?
YouTube and Bilibili provide separate fragmented MP4 video and audio files. Drive-In parses each file's `sidx` table, exposes the byte ranges as local fMP4 HLS playlists, and prefetches roughly 30 seconds of segments. This preserves original quality and seek support without a local transcode.

### Why Plex HLS instead of local ffmpeg?
Plex's built-in HLS transcoder handles codec compatibility, subtitle burn-in, adaptive bitrate, and hardware acceleration. Drive-In proxies Plex playlists and media segments through the same HLS path used by Mediabunny.

### SharedArrayBuffer requirement
The audio ring buffer uses `SharedArrayBuffer`, which requires:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

Use `credentialless` rather than `require-corp` so proxied external media remains usable.


### Bilibili CDN anti-hotlink 403
Bilibili's CDN checks `Accept`, `Accept-Language`, `Sec-Fetch-Mode` headers in addition to `Referer` and `User-Agent`. Missing any of these causes intermittent 403. **Solution**: use yt-dlp's per-format `http_headers` field — it contains all correct headers. Store them in proxyMap and forward on every request.

### YouTube subtitle HLS playlists
For long videos, YouTube's subtitle VTT URL returns an HLS playlist (`#EXTM3U`) instead of actual VTT content. Each segment is a `timedtext` API URL covering ~600 seconds. Must fetch all segments and merge into a single VTT file.

### Bilibili inline subtitles
Bilibili subtitles are embedded in yt-dlp JSON as inline `data` (SRT format), not URLs. The `--write-sub` flag is required in `ytdlp -j` for Bilibili to include them. Convert SRT → VTT before caching.

### YouTube 429 rate limiting
YouTube aggressively rate-limits IPs. `--cookies-from-browser chrome` + keeping yt-dlp updated is the best defense. Subtitle fetches also get 429'd — cache all downloaded subtitles to `.media-cache/subs/` to avoid repeat requests.

### yt-dlp requires Deno for YouTube
Since yt-dlp 2025.11.12, a JavaScript runtime (Deno recommended) is required for YouTube's nsig challenge solving. Without it: `No video formats found`. Keep both yt-dlp and Deno updated.

### COEP blocks external images
`Cross-Origin-Embedder-Policy: credentialless` blocks cross-origin images (Bilibili thumbnails) that don't return CORS headers. Proxy all external thumbnails through `/api/thumb?url=...` and cache to disk.

### CSS .hidden class must be global
Element-specific `.hidden` rules (like `#btn-subs.hidden { display: none }`) are error-prone — new elements forget to add their own rule. Use a single global `.hidden { display: none !important; }` at the top of the stylesheet. Exception: elements with transition effects (like `#overlay.hidden` using opacity fade).

### Canvas intercepts pointer events
The playback canvas covers `#player-container` entirely. `#controls` sits on top with `pointer-events: none` when auto-hidden. Don't filter `e.target.closest("#controls")`; it blocks click-to-pause across the full player surface.

### Plex transcode offset is in seconds, not milliseconds
Plex's `/video/:/transcode/universal/start.m3u8?offset=N` expects seconds. Passing milliseconds creates absurd `EXT-X-START:TIME-OFFSET`.

### Plex subtitle selection requires PUT before transcode
Passing `subtitleStreamID` in the transcode URL doesn't work. Must first `PUT /library/parts/<partId>?subtitleStreamID=<id>`.

### Plex progress reporting
- `POST /:/progress?key=<ratingKey>&time=<ms>&state=playing` — updates `viewOffset`
- `POST /:/timeline` does NOT update `viewOffset`
- `viewOffset` is in milliseconds

## API Reference

### Dev Tools
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/dev/reload` | POST | Force player browser refresh via WebSocket |
| `/api/dev/player` | GET | Live player state (currentTime, duration, isPlaying) |

### Playback
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/play` | POST | Play a URL (YouTube, Bilibili, HLS, mp4) |
| `/api/control` | POST | Pause/resume/stop playback |
| `/api/status` | GET | Current server + player state |
| `/api/history` | GET | Play history with Plex viewOffset enrichment |

### Plex
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plex/libraries` | GET | List Plex libraries |
| `/api/plex/library/:id` | GET | List items in a library |
| `/api/plex/show/:id/episodes` | GET | List episodes of a show |
| `/api/plex/search?q=` | GET | Search Plex library |
| `/api/plex/subtitles/:id` | GET | List subtitle tracks |
| `/api/plex/audio/:id` | GET | List audio tracks |
| `/api/plex/play` | POST | Play a Plex item (with optional subtitle, audio, offset) |
| `/api/plex/progress` | POST | Report playback progress to Plex |
| `/api/plex/thumb?path=` | GET | Proxy Plex thumbnails |

### Subtitles
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/subtitles` | GET | List subtitle tracks for current playback |
| `/api/subtitles/select` | POST | Select/disable subtitle (`{lang}` or `{lang: null}`) |
| `/api/subs/:key/:file` | GET | Serve cached VTT file |

### Stream Proxy
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/proxy?id=` | GET | Raw stream proxy with yt-dlp headers |
| `/api/proxy/hls?id=` | GET | HLS proxy with URL rewriting |
| `/api/proxy/range?id=&r=` | GET | Byte-range proxy for fragmented MP4 segments |
| `/api/dash/hls/:playlist` | GET | Generated fMP4 HLS playlists |
| `/api/dash/:mapId/:seg` | GET | fMP4 segment serving (init.mp4 / 0.mp4 etc.) |
| `/api/thumb?url=` | GET | External thumbnail proxy with disk cache |
| `/api/hls/*` | GET | Serve local HLS cache (pipeline fallback) |

### Caching
| Path | Contents | TTL |
|------|----------|-----|
| `.media-cache/subs/{videoId}/` | VTT subtitle files | Permanent |
| `.media-cache/thumbs/` | Thumbnail images | Permanent |
| `.play-history.json` | Play history | Permanent |
| `.hls-cache/` | ffmpeg HLS segments (pipeline fallback) | Cleaned on startup |

## Planned Features

### Completed
- ✅ fMP4 HLS playback for YouTube/Bilibili (`sidx` parsing)
- ✅ Dual subtitle display (select multiple languages simultaneously)
- ✅ Subtitle caching to disk (.media-cache/subs/)
- ✅ Thumbnail caching to disk (.media-cache/thumbs/)
- ✅ External subtitle renderer (custom VTT parser + HTML overlay)
- ✅ Bilibili inline SRT subtitle support
- ✅ YouTube/Bilibili CDN header forwarding (yt-dlp http_headers)
- ✅ Pause/resume fix (play() instead of resume())
- ✅ Click-to-pause on video area
- ✅ YouTube-style controls UI
- ✅ Remember subtitle preference (localStorage)
- ✅ CLI dual subtitle support (`drivein sub zh-CN en-US`)
- ✅ yt-dlp cookies-from-browser for YouTube 429 mitigation
- ✅ Plex audio track selection
- ✅ Plex subtitle selection
- ✅ Discord bot integration (via OpenClaw agent + skill)
- ✅ Cloudflare Tunnel for remote access

### In Progress / Next
- [ ] URL refresh on CDN expiry (Bilibili: 2hr, YouTube: 6hr) — re-resolve via yt-dlp when proxy gets 403
- [ ] Seek for split-stream HLS content across segment boundaries
- [ ] Buffering indicator during split-stream segment loading

### Future
- Keyboard shortcuts (Space: pause, Left/Right: seek, M: mute)
- Mobile remote control (QR code pair, browse/queue from phone)
- Resolution/quality selection for YouTube/Bilibili
- Auto-start Cloudflare Tunnel on server boot
- Bilibili danmaku (弹幕) overlay
