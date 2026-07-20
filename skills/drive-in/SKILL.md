---
name: drive-in
description: >
  Control a running Drive-In Tesla media player. Use for URL playback, Plex
  browsing, playback control, subtitles, audio tracks, queues, and playlists.
tags:
  - tesla
  - media
  - video
  - plex
  - player
---

# Drive-In

Use the published `drivein` CLI. It is an HTTP client for a separately running Drive-In server.

## Setup

```bash
npm install -g @drive-in/cli
drivein config set server http://your-server:9090
drivein status
```

Inside this repository, `npx drivein` is equivalent. The server can also be selected with `--server` or `DRIVEIN_SERVER`.

## Operating rules

- Use `--json` whenever output will be parsed.
- Quote URLs and search queries.
- Run `status` before changing tracks or subtitles for the current item.
- Search or list Plex items first; do not guess rating keys.
- Surface CLI errors instead of claiming playback started.
- The server has no built-in authentication. Do not expose it directly to the public internet.

## Playback

```bash
drivein play "<url>"
drivein pause
drivein resume
drivein stop
drivein status
```

URLs may point to YouTube, Bilibili, HLS, or MP4 media.

## Plex

```bash
drivein plex libraries
drivein plex movies -n 20
drivein plex shows -n 20
drivein plex episodes <showId>
drivein plex search "<query>"
drivein plex play <ratingKey>
```

Short aliases `movies`, `shows`, `search`, and `eps` are also available.

List tracks before selecting them:

```bash
drivein plex subs <ratingKey>
drivein plex audio <ratingKey>
drivein plex play <ratingKey> --sub <subtitleId> --audio <audioId>
```

Plex playback resumes from its recorded progress. Text subtitles are browser-rendered; image subtitles use Plex burn-in.

## Current subtitles

```bash
drivein subs
drivein sub <language-or-stream-id>
drivein sub <first-language> <second-language>
drivein sub
```

`subs` detects whether the current item is Plex or a URL source. Calling `sub` without arguments disables subtitles.

## Queue and playlists

```bash
drivein queue list
drivein queue add "<url>"
drivein queue plex <ratingKey>
drivein queue next
drivein queue remove <itemId>
drivein queue clear

drivein playlist list
drivein playlist create "<name>"
drivein playlist add <playlistId> "<url>"
drivein playlist plex <playlistId> <ratingKey>
drivein playlist import "<playlist-url>"
drivein playlist enqueue <playlistId>
```

Use `--next` on supported queue/enqueue commands to place items at the front.

## Help and failures

Run `drivein --help` or `drivein <command> --help` for the current command surface. Exit code `8` means the server could not be reached; other nonzero codes represent usage, empty results, HTTP failures, or permission errors.
