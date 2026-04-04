---
name: drive-in
description: >
  Use `drivein` CLI to play videos on Tesla and control playback. Supports YouTube,
  Bilibili, Plex library, and direct HLS/mp4 URLs. Invoke when the user wants to
  watch something in the car — play a movie, put on a YouTube video, watch Bilibili,
  browse their Plex library, pick a TV episode, switch subtitles or audio tracks,
  or control what's playing (pause, resume, stop).
tags:
  - tesla
  - media
  - video
  - plex
  - player
---

# drive-in

Control video playback on Tesla via CLI.

## When to use

- User asks to play a video (YouTube, Bilibili, or any URL)
- User wants to watch a movie or TV show from their Plex library
- User asks to pause, resume, stop, or check what's currently playing
- User wants to browse available movies, shows, or search for something to watch
- User asks to switch subtitles, audio tracks, or pick a specific episode

## Play a URL

Accepts YouTube, Bilibili, direct HLS (.m3u8), and mp4 URLs.

```bash
drivein play "<url>"
```

The server resolves the URL and starts playback on the Tesla browser automatically.
Returns the resolved title and stream type.

## Playback control

```bash
drivein pause                         # pause current playback
drivein resume                        # resume paused playback
drivein stop                          # stop and clear current playback
drivein status                        # show current state, title, progress
```

`status` returns: playback state, title, current time, duration, mute state, and whether the player browser is connected.

## Plex library

### Browse

```bash
drivein plex libraries                # list all Plex libraries (movies, TV, etc.)
drivein movies                        # list movies (shortcut for plex movies)
drivein movies -n 50                  # list up to 50 movies
drivein shows                         # list TV shows
drivein shows -n 50                   # list up to 50 shows
drivein search "<query>"              # search across all Plex libraries
drivein eps <showId>                  # list all episodes of a show (grouped by season)
```

Each item includes a `ratingKey` — use it to play or query subtitles/audio.

### Play from Plex

```bash
drivein plex play <ratingKey>                     # play a movie or episode
drivein plex play <ratingKey> --sub <subtitleId>  # play with a specific subtitle track
drivein plex play <ratingKey> --audio <audioId>   # play with a specific audio track
drivein plex play <ratingKey> --sub <id> --audio <id>  # both
```

Plex handles transcoding, so all codecs and subtitle formats are supported.
Playback resumes from where the user left off (Plex tracks progress).

### Subtitles (Plex)

```bash
drivein plex subs <ratingKey>         # list available subtitle tracks (by ratingKey)
drivein subs                          # list subtitles for CURRENT playback (auto-detects Plex)
drivein sub <subtitleStreamID>        # switch subtitle mid-playback (resumes from current position)
drivein sub                           # disable subtitles
```

When Plex is playing, `drivein subs` and `drivein sub` automatically detect it and use the Plex subtitle API. No need to re-specify the ratingKey.

### Audio tracks (Plex)

```bash
drivein plex audio <ratingKey>        # list available audio tracks
```

Returns audio ID, language, codec, and channel count. Shows which track is currently selected.
Pass the desired audio ID to `plex play --audio <id>`.

## Subtitles (YouTube / Bilibili / non-Plex)

For YouTube and Bilibili, subtitles (including creator-uploaded and auto-generated) are automatically downloaded and cached locally. Supports dual subtitle display.

```bash
drivein subs                          # list available subtitle tracks for current playback
drivein sub en-US                     # select English subtitles
drivein sub zh-CN                     # select Chinese subtitles
drivein sub zh-CN en-US              # dual subtitles (both displayed simultaneously)
drivein sub                           # disable all subtitles (no argument)
```

Language codes vary by source: YouTube uses `en`, `zh-Hans`; Bilibili uses `en-US`, `zh-CN`. Use `drivein subs` to see exact codes.

## Typical workflows

**Play a URL the user provided:**
```bash
drivein play "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

**Find and play a movie from Plex:**
```bash
drivein --json search "inception"     # find the ratingKey
drivein plex play 12345               # play it
```

**Play a specific TV episode:**
```bash
drivein --json shows                  # find the showId
drivein --json eps 6789               # list episodes, find the ratingKey
drivein plex play 11111               # play the episode
```

**Switch subtitles (Plex, during playback):**
```bash
drivein --json subs                   # list available tracks (auto-detects Plex)
drivein sub 67890                     # switch to subtitle 67890 (resumes from current position)
drivein sub                           # turn off subtitles
```

**Switch audio track (Plex):**
```bash
drivein --json plex audio 12345       # list available tracks
drivein plex play 12345 --audio 44444 # replay with chosen audio
```

**Switch subtitles (YouTube / Bilibili):**
```bash
drivein --json subs                   # list available tracks
drivein sub zh-CN                     # select Chinese
drivein sub zh-CN en-US              # dual subtitles
drivein sub                           # turn off subtitles
```

## Raw API

Fallback when the CLI doesn't cover a use case. Base URL from `$DRIVEIN_SERVER`.

| Method | Endpoint | Body / Params | Description |
|--------|----------|---------------|-------------|
| POST | `/api/play` | `{"url":"<url>"}` | Play a URL |
| POST | `/api/control` | `{"action":"pause\|resume\|stop"}` | Control playback |
| GET | `/api/status` | — | Server + player state |
| GET | `/api/history` | — | Play history with resume offsets |
| GET | `/api/subtitles` | — | List subtitles for current non-Plex playback |
| POST | `/api/subtitles/select` | `{"lang":"en"}` or `{"lang":null}` | Select/disable subtitle |
| GET | `/api/plex/libraries` | — | List Plex libraries |
| GET | `/api/plex/library/:id` | `?size=N` | List items in a library |
| GET | `/api/plex/show/:id/episodes` | — | List episodes of a show |
| GET | `/api/plex/search` | `?q=<query>` | Search Plex library |
| GET | `/api/plex/subtitles/:id` | — | List Plex subtitle tracks |
| GET | `/api/plex/audio/:id` | — | List Plex audio tracks |
| POST | `/api/plex/play` | `{"ratingKey":"...", "subtitleStreamID":"...", "audioStreamID":"..."}` | Play Plex item |
| POST | `/api/plex/progress` | `{"ratingKey":"...", "timeMs":<ms>}` | Report progress to Plex |

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON output. Always use when parsing programmatically. |
| `-s, --server <url>` | Server URL (default: `$DRIVEIN_SERVER` or `http://localhost:9090`) |
| `-n, --limit <n>` | Max items to return for list commands (default: 20) |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic failure |
| 2 | Invalid usage |
| 3 | Empty results (query matched nothing) |
| 8 | Connection error (retryable — server may be down) |
