# Drive-In Development Notes

## Architecture Decisions

### Why libmedia (AVPlayer) instead of native `<video>`?
Tesla freezes `<video>` element rendering while driving. libmedia renders via WebAssembly + WebGL onto `<canvas>`, bypassing this restriction. Reverse-engineered from tesla-player.com which uses the same approach.

### Why not Vite build for production?
libmedia's ESM dist has ~30 dynamic worker chunk files (`163.avplayer.js`, etc.) that Vite bundles into a single file, breaking dynamic imports. Serving the source directly via Express + import map keeps all chunks intact. Error symptom: `register io task failed, ret: -2097152`.

### Why DASH instead of ffmpeg HLS pipeline?
YouTube/Bilibili provide separate video+audio DASH streams. The old approach piped `yt-dlp | ffmpeg` to remux into HLS, but this was fragile (PTS sync issues, audio re-encoding, slow startup, no seek). DASH approach: proxy the original streams directly, parse `sidx` box for segment byte ranges, generate SegmentTemplate MPD. Benefits: instant start, no transcoding, proper seek support, no disk I/O.

### Why Plex native transcode instead of local ffmpeg?
Plex's built-in transcoder handles all codec compatibility (TrueHD → AAC, HEVC → H.264, PGS subtitle burn-in), adaptive bitrate, and hardware acceleration. Our ffmpeg remux failed on TrueHD audio (not supported in HLS containers).

### Why custom VTT renderer instead of libmedia subtitle API?
libmedia's `loadExternalSubtitle()` exists but does not render subtitles in canvas mode — canvas replaces the native video element, so there's no `<track>` element for WebVTT. We parse VTT ourselves and render via an HTML overlay div synced to the TIME event.

## Gotchas & Pitfalls

### libmedia SharedArrayBuffer requirement
libmedia needs `SharedArrayBuffer` for its WebAssembly workers. This requires COOP/COEP headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```
Use `credentialless` (not `require-corp`) — the latter blocks cross-origin resources without CORS headers.

### libmedia DASH — Worker can't resolve relative URLs
libmedia's DashIOLoader runs in a Worker thread. `fetch("/api/dash/manifest.mpd")` fails with `Failed to parse URL from /api/dash/manifest.mpd` because Workers have no `location.origin`. **Always pass absolute URLs** (`http://localhost:9090/...`) to `player.load()`.

### libmedia DASH — BaseURL concatenation (not resolution)
libmedia's MPD parser joins URLs with simple concatenation: `c(base, url) { return /^https?:\/\//.test(url) ? url : base + url }`. Relative URLs like `/api/proxy?id=x` become `http://host/api/dash//api/proxy?id=x` (broken). Fix: use absolute `http://` URLs or set MPD-level `<BaseURL>` and use relative paths without leading `/`.

### libmedia DASH — XML &amp; encoding in URLs
libmedia's XML parser does NOT decode `&amp;` → `&` in attribute values. If SegmentTemplate `media="api/seg?m=xxx&amp;s=$Number$"`, the actual fetch URL contains literal `&amp;`. **Avoid query parameters in MPD URLs entirely** — use path-based URLs like `api/dash/{mapId}/{number}.mp4`.

### libmedia resume() vs play() after pause
`player.resume()` only resumes the AudioContext (from browser autoplay suspension), it does NOT resume video playback. After `player.pause()`, use `player.play()` to resume. Symptom: `resume()` returns success but status stays at 8 (PAUSED).

### libmedia getStatus() values
- 1 = STOPPED, 2 = DESTROYING, 5 = PLAYING, 6 = PLAYED, 8 = PAUSED
- Use `getStatus()` instead of tracking `isPlaying` manually — async events (PLAYING/PAUSED) can desync the tracked state.

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
libmedia's canvas covers `#player-container` entirely. `#controls` sits on top with `pointer-events: none` (auto-hidden). Clicks hit the controls div (not the canvas) even when invisible. Don't filter `e.target.closest("#controls")` — it blocks all click-to-pause functionality.

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
| `/api/proxy/range?id=&r=` | GET | Byte-range proxy for DASH segments |
| `/api/dash/:mapId/:seg` | GET | DASH segment serving (init.mp4 / 0.mp4 etc.) |
| `/api/dash/manifest.mpd` | GET | Generated DASH MPD |
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
- ✅ DASH playback for YouTube/Bilibili (SegmentTemplate, sidx parsing)
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
- [ ] Seek for DASH content — player.seek() works but needs testing across segment boundaries
- [ ] Buffering indicator during DASH segment loading

### Future
- Keyboard shortcuts (Space: pause, Left/Right: seek, M: mute)
- Mobile remote control (QR code pair, browse/queue from phone)
- Resolution/quality selection for YouTube/Bilibili
- Auto-start Cloudflare Tunnel on server boot
- Bilibili danmaku (弹幕) overlay
