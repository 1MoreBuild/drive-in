#!/usr/bin/env node
import { program } from "commander";

// --- Exit codes (semantic) -------------------------------------------

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, EMPTY: 3, AUTH: 4, NOT_FOUND: 5, FORBIDDEN: 6, RATE_LIMIT: 7, CONN: 8 };

// --- Globals ---------------------------------------------------------

let serverUrl;
let jsonMode = false;
let quietMode = false;
let noColor = false;

program
  .name("drivein")
  .description("Drive-In: in-car media player for Tesla")
  .version("0.1.0")
  .option("-s, --server <url>", "Server URL", process.env.DRIVEIN_SERVER || "http://localhost:9090")
  .option("--json", "Output as JSON")
  .option("-q, --quiet", "Suppress output (errors only)")
  .option("--no-color", "Disable colored output")
  .hook("preAction", (cmd) => {
    const opts = cmd.opts();
    serverUrl = opts.server;
    jsonMode = opts.json;
    quietMode = opts.quiet;
    noColor = opts.color === false || !!process.env.NO_COLOR || process.env.TERM === "dumb";
  });

// --- Output helpers --------------------------------------------------

const isTTY = process.stdout.isTTY;

function out(data) {
  if (quietMode) return;
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (Array.isArray(data)) {
    for (const row of data) console.log(row);
  } else {
    console.log(data);
  }
}

function die(message, fix, code = EXIT.FAIL) {
  if (jsonMode) {
    console.error(JSON.stringify({ error: code === EXIT.CONN ? "CONNECTION" : "ERROR", message, fix, retryable: code === EXIT.CONN }));
  } else {
    console.error(`Error: ${message}`);
    if (fix) console.error(`  Fix: ${fix}`);
  }
  process.exit(code);
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function dim(s) { return isTTY && !noColor ? `\x1b[2m${s}\x1b[0m` : s; }
function bold(s) { return isTTY && !noColor ? `\x1b[1m${s}\x1b[0m` : s; }
function formatTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
}

// --- API client ------------------------------------------------------

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, opts);
  } catch {
    die(`Cannot reach server at ${serverUrl}`, "drivein --server <url> status", EXIT.CONN);
  }

  const data = await res.json();
  if (!res.ok) {
    const msg = data.error || res.statusText;
    const code = { 401: EXIT.AUTH, 403: EXIT.FORBIDDEN, 404: EXIT.NOT_FOUND, 429: EXIT.RATE_LIMIT }[res.status] || EXIT.FAIL;
    die(msg, null, code);
  }
  return data;
}

// --- Playback commands -----------------------------------------------

program
  .command("play <url>")
  .description("Play a URL (YouTube, Bilibili, HLS, mp4, etc.)")
  .action(async (url) => {
    if (!jsonMode) process.stderr.write(`Resolving ${url}...\n`);
    const result = await api("POST", "/api/play", { url });
    out(jsonMode ? result : `Now playing: ${bold(result.title)}${result.isLive ? " [LIVE]" : ""}`);
  });

program
  .command("pause")
  .description("Pause playback")
  .action(async () => {
    await api("POST", "/api/control", { action: "pause" });
    out(jsonMode ? { ok: true, action: "pause" } : "Paused");
  });

program
  .command("resume")
  .description("Resume playback")
  .action(async () => {
    await api("POST", "/api/control", { action: "resume" });
    out(jsonMode ? { ok: true, action: "resume" } : "Resumed");
  });

program
  .command("stop")
  .description("Stop playback")
  .action(async () => {
    await api("POST", "/api/control", { action: "stop" });
    out(jsonMode ? { ok: true, action: "stop" } : "Stopped");
  });

program
  .command("status")
  .description("Show current playback status")
  .action(async () => {
    const s = await api("GET", "/api/status");
    if (jsonMode) return out(s);
    if (quietMode) return;
    console.log(`${pad("Status:", 10)} ${s.status}`);
    console.log(`${pad("Player:", 10)} ${s.playerConnected ? "connected" : "not connected"}`);
    if (s.title) console.log(`${pad("Title:", 10)} ${s.title}`);
    if (s.resolvedUrl) console.log(`${pad("Stream:", 10)} ${dim(s.resolvedUrl.slice(0, 80))}`);
  });

// --- Plex commands ---------------------------------------------------

const plex = program
  .command("plex")
  .description("Browse and play from Plex library");

async function findPlexLib(type) {
  const libs = await api("GET", "/api/plex/libraries");
  const lib = libs.find((l) => l.type === type);
  if (!lib) die(`No ${type} library found in Plex`);
  return lib;
}

function formatMovie(m) {
  const id = dim(`[${m.ratingKey}]`);
  const title = bold(m.title);
  const year = m.year || "?";
  const codec = (m.videoCodec || "?").toUpperCase();
  const res = m.resolution || "";
  const dur = m.duration ? `${m.duration}min` : "";
  return `  ${id} ${title} ${dim(`(${year})`)}  ${codec} ${res} ${dur}`;
}

function formatShow(s) {
  const id = dim(`[${s.ratingKey}]`);
  const title = bold(s.title);
  const year = s.year || "?";
  const eps = s.leafCount || "?";
  return `  ${id} ${title} ${dim(`(${year})`)}  ${eps} episodes`;
}

function formatEpisode(ep) {
  const id = dim(`[${ep.ratingKey}]`);
  const num = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
  const dur = ep.duration ? dim(`${ep.duration}min`) : "";
  return `  ${id} ${bold(num)} ${ep.title}  ${dur}`;
}

// -- plex subcommands

plex
  .command("libraries")
  .alias("lib")
  .description("List Plex libraries")
  .action(async () => {
    const libs = await api("GET", "/api/plex/libraries");
    if (jsonMode) return out(libs);
    for (const lib of libs) {
      console.log(`  ${dim(`[${lib.id}]`)} ${bold(lib.title)} ${dim(`(${lib.type})`)}`);
    }
  });

plex
  .command("movies")
  .description("List movies")
  .option("-n, --limit <n>", "Number of items", "20")
  .action(async (opts) => {
    const lib = await findPlexLib("movie");
    const data = await api("GET", `/api/plex/library/${lib.id}?size=${opts.limit}`);
    if (jsonMode) return out(data.items);
    if (!data.items.length) return die("No movies found", null, EXIT.EMPTY);
    for (const m of data.items) console.log(formatMovie(m));
    if (data.total > data.items.length) console.log(dim(`  ... and ${data.total - data.items.length} more (-n ${data.total})`));
  });

plex
  .command("shows")
  .description("List TV shows")
  .option("-n, --limit <n>", "Number of items", "20")
  .action(async (opts) => {
    const lib = await findPlexLib("show");
    const data = await api("GET", `/api/plex/library/${lib.id}?size=${opts.limit}`);
    if (jsonMode) return out(data.items);
    if (!data.items.length) return die("No shows found", null, EXIT.EMPTY);
    for (const s of data.items) console.log(formatShow(s));
    if (data.total > data.items.length) console.log(dim(`  ... and ${data.total - data.items.length} more (-n ${data.total})`));
  });

plex
  .command("episodes <showId>")
  .alias("eps")
  .description("List episodes of a show")
  .action(async (showId) => {
    const eps = await api("GET", `/api/plex/show/${showId}/episodes`);
    if (jsonMode) return out(eps);
    if (!eps.length) return die("No episodes found", null, EXIT.EMPTY);
    for (const ep of eps) console.log(formatEpisode(ep));
  });

plex
  .command("search <query>")
  .description("Search Plex library")
  .action(async (query) => {
    const results = await api("GET", `/api/plex/search?q=${encodeURIComponent(query)}`);
    if (jsonMode) return out(results);
    if (!results.length) return die("No results found", null, EXIT.EMPTY);
    for (const r of results) {
      const id = dim(`[${r.ratingKey}]`);
      const type = dim(`[${r.type}]`);
      console.log(`  ${id} ${bold(r.title)} ${dim(`(${r.year || "?"})`)} ${type}`);
    }
  });

plex
  .command("subs <ratingKey>")
  .description("List available subtitles for a Plex item")
  .action(async (ratingKey) => {
    const subs = await api("GET", `/api/plex/subtitles/${ratingKey}`);
    if (jsonMode) return out(subs);
    if (!subs.length) return die("No subtitles found", null, EXIT.EMPTY);
    for (const s of subs) {
      console.log(`  ${dim(`[${s.id}]`)} ${bold(s.displayTitle)} ${s.title ? dim(s.title) : ""} ${dim(`(${s.codec})`)}`);
    }
  });

plex
  .command("play <ratingKey>")
  .description("Play a Plex item by rating key")
  .option("--sub <id>", "Subtitle stream ID (use 'plex subs' to list)")
  .option("--audio <id>", "Audio stream ID (use 'plex audio' to list)")
  .action(async (ratingKey, opts) => {
    if (!jsonMode) process.stderr.write("Starting playback...\n");
    const body = { ratingKey };
    if (opts.sub) body.subtitleStreamID = opts.sub;
    if (opts.audio) body.audioStreamID = opts.audio;
    const result = await api("POST", "/api/plex/play", body);
    out(jsonMode ? result : `Now playing: ${bold(result.title)}`);
  });

// --- Subtitle commands -----------------------------------------------

// Helper: detect if current playback is Plex, return { isPlex, ratingKey, currentTime }
async function getPlaybackContext() {
  const status = await api("GET", "/api/status");
  const isPlex = status.url?.startsWith("plex://");
  const ratingKey = isPlex ? status.url.replace("plex://", "") : null;
  const currentTime = status.player?.currentTime || 0;
  return { isPlex, ratingKey, currentTime, status };
}

program
  .command("subs")
  .description("List available subtitles for current playback (Plex or YouTube/Bilibili)")
  .action(async () => {
    const ctx = await getPlaybackContext();
    if (ctx.isPlex) {
      const subs = await api("GET", `/api/plex/subtitles/${ctx.ratingKey}`);
      if (jsonMode) return out(subs);
      if (!subs.length) return die("No subtitles found", null, EXIT.EMPTY);
      for (const s of subs) {
        console.log(`  ${dim(`[${s.id}]`)} ${bold(s.displayTitle)} ${s.title ? dim(s.title) : ""} ${dim(`(${s.codec})`)}`);
      }
    } else {
      const subs = await api("GET", "/api/subtitles");
      if (jsonMode) return out(subs);
      if (!subs.length) return die("No subtitles available", null, EXIT.EMPTY);
      for (const s of subs) {
        console.log(`  ${dim(`[${s.lang}]`)} ${bold(s.name)}${s.auto ? dim(" (auto)") : ""}`);
      }
    }
  });

program
  .command("sub [langs...]")
  .description("Select subtitle(s) — Plex: pass stream ID; YouTube/Bilibili: pass lang code(s). Omit to disable.")
  .action(async (langs) => {
    const ctx = await getPlaybackContext();

    if (ctx.isPlex) {
      // Plex: re-request transcode with subtitle from current position
      const subId = langs[0] || null;
      const offsetMs = Math.floor(ctx.currentTime * 1000);
      const body = { ratingKey: ctx.ratingKey, offset: offsetMs };
      if (subId) body.subtitleStreamID = subId;
      const result = await api("POST", "/api/plex/play", body);
      if (jsonMode) return out(result);
      return out(subId ? `Subtitle: ${subId} (resuming at ${formatTime(ctx.currentTime)})` : "Subtitles off");
    }

    // Non-Plex: existing multi-select logic
    if (!langs.length) {
      const result = await api("POST", "/api/subtitles/select", { lang: null });
      if (jsonMode) return out(result);
      return out("Subtitles off");
    }
    const results = [];
    for (const lang of langs) {
      const result = await api("POST", "/api/subtitles/select", { lang });
      results.push(result);
    }
    if (jsonMode) return out(results);
    out(`Subtitle: ${results.map((r) => r.name || r.lang).join(" + ")}`);
  });

// --- Audio track commands (Plex) -------------------------------------

plex
  .command("audio <ratingKey>")
  .description("List available audio tracks for a Plex item")
  .action(async (ratingKey) => {
    const tracks = await api("GET", `/api/plex/audio/${ratingKey}`);
    if (jsonMode) return out(tracks);
    if (!tracks.length) return die("No audio tracks found", null, EXIT.EMPTY);
    for (const t of tracks) {
      const sel = t.selected ? "●" : " ";
      const codec = (t.codec || "").toUpperCase();
      const ch = t.channels ? `${t.channels}ch` : "";
      console.log(`  ${sel} ${dim(`[${t.id}]`)} ${bold(t.displayTitle || t.language || "Unknown")} ${dim(`${codec} ${ch}`.trim())}`);
    }
  });

// --- Desire-path shortcuts -------------------------------------------

program.command("movies", { hidden: true }).description("Shortcut for: plex movies")
  .option("-n, --limit <n>", "Number of items", "20")
  .action((opts) => plex.commands.find((c) => c.name() === "movies").parseAsync(["-n", opts.limit], { from: "user" }));

program.command("shows", { hidden: true }).description("Shortcut for: plex shows")
  .option("-n, --limit <n>", "Number of items", "20")
  .action((opts) => plex.commands.find((c) => c.name() === "shows").parseAsync(["-n", opts.limit], { from: "user" }));

program.command("search <query>", { hidden: true }).description("Shortcut for: plex search")
  .action((query) => plex.commands.find((c) => c.name() === "search").parseAsync([query], { from: "user" }));

program.command("eps <showId>", { hidden: true }).description("Shortcut for: plex episodes")
  .action((showId) => plex.commands.find((c) => c.name() === "episodes").parseAsync([showId], { from: "user" }));

program.parse();
