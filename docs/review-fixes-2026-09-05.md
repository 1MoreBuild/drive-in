# Repository review follow-up — 2026-09-05

This change addresses the findings from the review of `00d2785`. It preserves the separately requested removal of Docker support. It does not deploy, restart the resident service, change local credentials, or publish a commit.

## Fixes

| Finding | Resolution | Regression coverage |
| --- | --- | --- |
| HLS cache collisions | Generic segment keys include the full URL and exact Range. Old pathname-only keys are not reused. Provider-specific signed-URL identities remain supported. | Cross-origin, query and Range unit/API tests |
| Short HLS stuck buffering | ENDLIST playlists expose whether every remaining segment, including the current one, is cached. Only this fully available finite tail bypasses the forward-buffer target; decoding is still required. | Finite/live policy tests; Chromium short HLS completion |
| Remote Plex embedded subtitles fail playback | Missing/inaccessible source paths receive mutable versions and burn-in descriptors. No unavailable local extraction is scheduled for those descriptors. | Missing-path unit/API tests; Chromium Plex HLS playback |
| Audio shorter than video freezes playback | The worklet drains a partial final audio quantum. After audio EOF and complete drain, the clock continues from the same position on wall time. Seeking restores the audio clock. | Worklet quantum and clock tests; real short-audio video with seek-back |
| Old stop stops new play | Stop is broadcast with the synchronous stop intent, before awaiting asynchronous resource cleanup. | Delayed Plex stop interleaved with new play |
| Mute lost on player replacement | Every new player applies the current mute state, independently of audio-context unlock. | Chromium replacement checks both volume and gain |
| Paused recovery loops | A new paused player confirms readiness without requiring playback progress. The old player cannot confirm the replacement. | Chromium recovery remains paused beyond the confirmation timeout without a second request |
| Late subtitles reappear | Track loading is cancellable and checks current request identity. Disable, removal, replacement and new playback invalidate old loads. Cancelled loads do not trigger Plex fallback. | Delayed-response browser test, disable and same-language replacement |
| Plex offset zero ignored | Explicit zero is preserved; non-numeric, negative and non-finite offsets are rejected. Omitted offset still resumes Plex progress. | API tests for zero, omitted and invalid offsets |
| Missing transcode initialization URI | Shared HLS rewriting handles URI attributes as well as media lines. | URI unit tests; real ffmpeg-to-HLS Chromium playback |
| URL SRT conversion undefined | The downloader is a testable module that imports the existing SRT converter. | Real local HTTP SRT download, conversion and saved VTT |
| Mandatory Chrome cookies | Cookies are optional, explicitly configured with yt-dlp's existing browser/file options. | Argument tests; DASH discovery fixture rejects unexpected browser-cookie arguments |
| Local .env ignored | Native Node.js env-file loading runs before logging and storage initialization. Root-relative default does not depend on cwd; exported settings take precedence. | Separate-process env loading/order/precedence tests |
| Docker deployment issues | Dockerfile, Compose, dockerignore, Docker CI and update configuration were removed at the user's request. | Repository reference and YAML checks |

The verification work also addressed an inherited seek-spinner race, allowed fully generated one-segment ffmpeg output to become ready, and made DASH self-probing use the actual bound port so an isolated port-zero server can exercise the production path.

## Implementation choices

No new runtime library was added. The implementation extends the existing buffer policy, shared audio ring, playback lifecycle and subtitle converter. HLS URI handling is shared between generic proxying and ffmpeg output rather than introducing another player or manifest dependency.

Node's native environment loader provides the needed env-file support ([Node.js process documentation](https://nodejs.org/api/process.html#processloadenvfilepath)). Browser/file cookie inputs use yt-dlp's supported options ([yt-dlp FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ)). HLS initialization URIs follow EXT-X-MAP ([RFC 8216](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.2.5)).

The dependency lockfile upgrades nanoid to 3.3.18, PostCSS to 8.5.28, qs to 6.16.0 and their two affected side-channel dependencies within existing version ranges. `npm audit` reports zero advisories after the update. No major dependency upgrade was required.

## Validation scope

Final `npm run check` passed: 64 player unit tests, 48 server unit tests, 16 player integration tests, 32 server integration tests and 18 E2E tests (178 total), followed by the production build. The full run includes the previously intermittent optimistic-seek assertion. `npm audit` reports 0 advisories; `git diff --check` passes.

The regression suite runs real FFmpeg, HTTP/WebSocket proxying, MP4 probing, HLS generation, Chromium/WebCodecs decoding and Canvas presentation. Direct, HLS, DASH split, ffmpeg fallback and Plex-proxied HLS are covered with generated local media. Plex metadata and external yt-dlp discovery are fixtures, not real provider acceptance.

Tests use temporary runtime directories/databases and disable local env-file loading. They do not borrow the resident service's cache, database, cookies or Plex connection.

Run:

```bash
npm run check
npm audit
git diff --check
```

Tesla hardware, moving-vehicle networks and real YouTube/Bilibili/Plex accounts still require acceptance after an explicitly authorized deployment. These fixtures do not prove those external conditions.

## Before deployment

- Review the existing root `.env`: it will now take effect on startup. Exported values still win.
- If the current installation relies on Chrome login, explicitly set `YTDLP_COOKIES_FROM_BROWSER=chrome`, or configure `YTDLP_COOKIES_FILE`. Keep credentials outside Git.
- Generic `.ts` entries using the old cache key will no longer be hit. They remain eligible for normal cache eviction; no live cache was deleted for this change.
- Deploy the server and rebuilt player together so the worklet EOF flag and player clock changes stay in sync.
- The working-tree fix is not a service restart, deployment, commit or push.
