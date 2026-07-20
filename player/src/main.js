import { state } from "./state.js";
import { initRouter, parseRoute, navigate } from "./router.js";
import { initControls, updatePlayButton, updateVolumeButton } from "./controls.js";
import { play, stop, seekToTime, togglePlayPause, showStatus, initMediaSession, updateMediaSession, reportProgress, setPlayerCallbacks } from "./player.js";
import { loadBrowseScreen, openEpisodes, renderPlaylists, renderQueue, updateSubsUI, updateAudioUI, toggleSubtitle, showBrowseFromEpisodes } from "./browse.js";
import { loadSubtitleTrack, disableExternalSubtitle } from "./subtitles.js";
import { plexPlaybackRequest, requestPlexPlayback } from "./plex-preferences.js";

const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
const connectionStatus = document.getElementById("connection-status");
const connectionStatusText = document.getElementById("connection-status-text");
let reconnectTimer = null;
let lastWsActivityAt = 0;
const WS_RECONNECT_DELAY_MS = 3_000;
const WS_STALE_AFTER_MS = 70_000;
const WS_HEALTH_CHECK_INTERVAL_MS = 15_000;

// --- Player callbacks (break circular dep player↔browse) -------------

setPlayerCallbacks({ updateSubsUI, updateAudioUI });

// --- Controls init (wire callbacks) ----------------------------------

initControls({
  onTogglePlayPause: togglePlayPause,
  onStop: stop,
  onSeekToTime: seekToTime,
  onSetVolume: (v) => { if (state.player) state.player.setVolume(v); },
});

// --- Router ----------------------------------------------------------

initRouter((route) => {
  if (route.view === "browse") {
    loadBrowseScreen();
  }
  // "player" and "show" views are handled by their triggers (play/openEpisodes)
});

// --- Audio unlock via user gesture -----------------------------------

function unlockAudio(event) {
  if (state.audioUnlocked) return;
  state.audioUnlocked = true;
  if (event?.target?.closest?.("#btn-volume")) event.stopImmediatePropagation();
  document.removeEventListener("click", unlockAudio, true);
  document.removeEventListener("touchstart", unlockAudio, true);
  console.log("[player] Audio unlocked");

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => ctx.close()).catch(() => {});
  } catch {}

  if (state.player) {
    try {
      state.player.setVolume(1);
      state.isMuted = false;
      updateVolumeButton();
      state.player.resume().catch(() => {});
    } catch {}
  }

  // Sync Media Session after user gesture so Tesla car UI shows correct playback state
  if (state.isPlaying) {
    updateMediaSession();
  }
}

document.addEventListener("click", unlockAudio, true);
document.addEventListener("touchstart", unlockAudio, true);

// --- MediaSession ----------------------------------------------------

initMediaSession();

// --- WebSocket -------------------------------------------------------

function showConnectionStatus(text = "Reconnecting…") {
  connectionStatusText.textContent = text;
  connectionStatus.classList.remove("hidden");
}

function hideConnectionStatus() {
  connectionStatus.classList.add("hidden");
}

function scheduleReconnect(delay = WS_RECONNECT_DELAY_MS) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function syncPlayerConnection(ws) {
  const rawStatus = state.player?.getStatus?.();
  const status = state.player
    ? (["stopped", "ended", "error"].includes(rawStatus) ? "idle" : rawStatus || (state.isPlaying ? "playing" : "paused"))
    : "idle";
  ws.send(JSON.stringify({ type: "status", status }));
  if (state.player) reportProgress();
}

async function restoreConnectedRoute() {
  const route = parseRoute();
  if (state.player || state.isPlaying) return;

  // Page refresh on /play?url=... or /play?plex=... — re-trigger playback
  if (route.view === "player" && (route.url || route.plex)) {
    showStatus("Resuming playback...");
    const endpoint = route.plex ? "/api/plex/play" : "/api/play";
    const body = route.plex ? plexPlaybackRequest(route.plex) : { url: route.url };
    const playbackRequest = route.plex
      ? requestPlexPlayback(body)
      : fetch(`${location.origin}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (response) => {
        if (response.ok) return response;
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Playback failed with ${response.status}`);
      });
    playbackRequest.catch((error) => {
      console.error("[playback] Resume failed:", error);
      showStatus(`Playback error: ${error.message}`);
      navigate("/", true);
      loadBrowseScreen();
    });
    return;
  }

  const browseData = await loadBrowseScreen();
  if (route.view === "show") {
    const show = browseData.shows.find((item) => String(item.ratingKey) === String(route.ratingKey));
    if (show) await openEpisodes(show);
    else {
      navigate("/", true);
      showStatus("Show not found");
    }
    return;
  }

  if (route.view === "player") navigate("/", true);
}

function connect() {
  if (
    state.ws
    && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)
  ) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/ws?role=player`;
  const ws = new WebSocket(wsUrl);

  state.ws = ws;
  lastWsActivityAt = Date.now();

  ws.onopen = () => {
    if (state.ws !== ws) return;
    console.log("[ws] Connected");
    lastWsActivityAt = Date.now();
    hideConnectionStatus();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    syncPlayerConnection(ws);
    restoreConnectedRoute().catch((error) => {
      console.error("[ws] Failed to restore route:", error);
      showStatus(`Connection restored, but the page failed to load: ${error.message}`);
    });
  };

  ws.onmessage = (e) => {
    if (state.ws !== ws) return;
    lastWsActivityAt = Date.now();
    try {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data);

      if (msg.type === "ping") {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        }
        return;
      }
      if (msg.type === "pong" || msg.type === "playerState") return;

      switch (msg.type) {
        case "play":
          state.externalSubs = [];
          state.activeExternalSubs.clear();
          btnAudio.classList.add("hidden");
          audioPanel.classList.add("hidden");
          showStatus(`Loading: ${msg.title || "..."}`);
          void play(msg.url, msg.title, {
            isLive: msg.isLive,
            liveDvr: msg.liveDvr || null,
            duration: msg.duration || 0,
            plex: msg.plex || null,
            startTime: msg.startTime || 0,
            sourceUrl: msg.sourceUrl || null,
            mediaSource: msg.mediaSource || null,
            autoplay: msg.autoplay !== false,
          }).catch((error) => console.error("[playback] Play transition failed:", error));
          break;
        case "pause":
          if (state.player) {
            state.player.pause().catch(() => {});
          }
          state.isPlaying = false;
          updatePlayButton();
          break;
        case "resume":
          if (state.player) {
            state.player.play().catch(() => {});
          }
          state.isPlaying = true;
          updatePlayButton();
          break;
        case "stop":
          void stop().catch((error) => console.error("[playback] Stop transition failed:", error));
          break;
        case "subtitlesAvailable":
          state.externalSubs = msg.subtitles || [];
          updateSubsUI();
          try {
            const prefs = JSON.parse(localStorage.getItem("preferred-sub-langs") || "[]");
            for (const lang of prefs) {
              if (state.externalSubs.find((s) => s.lang === lang)) {
                toggleSubtitle(lang);
              }
            }
          } catch {}
          break;
        case "subtitleSelect":
          if (msg.url && msg.lang) {
            state.activeExternalSubs.add(msg.lang);
            loadSubtitleTrack(msg.lang, msg.url);
          } else if (!msg.lang) {
            disableExternalSubtitle();
            state.activeExternalSubs.clear();
          }
          // Persist preference so next video auto-selects the same subtitles (CLI + UI)
          try {
            localStorage.setItem("preferred-sub-langs", JSON.stringify([...state.activeExternalSubs]));
          } catch {}
          updateSubsUI();
          break;
        case "queueUpdated":
          renderQueue(msg.queue || []);
          break;
        case "playlistsUpdated":
          renderPlaylists(msg.playlists || []);
          break;
        case "reload":
          location.reload();
          return;
      }
    } catch (err) {
      console.error("[ws] Parse error:", err);
    }
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    console.log("[ws] Disconnected, reconnecting in 3s...");
    showConnectionStatus("Reconnecting…");
    if (!state.player && !state.isPlaying) showStatus("Reconnecting…");
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws.close();
  };
}

connect();

function verifyConnection() {
  if (document.visibilityState === "hidden") return;
  const ws = state.ws;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    showConnectionStatus("Reconnecting…");
    scheduleReconnect(0);
    return;
  }
  if (
    ws.readyState === WebSocket.OPEN
    && Date.now() - lastWsActivityAt > WS_STALE_AFTER_MS
  ) {
    console.warn("[ws] Connection heartbeat is stale; reconnecting");
    showConnectionStatus("Restoring connection…");
    ws.close();
  }
}

setInterval(verifyConnection, WS_HEALTH_CHECK_INTERVAL_MS);
window.addEventListener("pageshow", verifyConnection);
window.addEventListener("online", verifyConnection);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") verifyConnection();
});
