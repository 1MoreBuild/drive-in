import { state } from "./state.js";
import { initRouter, parseRoute, navigate } from "./router.js";
import { initControls, updatePlayButton, updateVolumeButton } from "./controls.js";
import { getPlaybackPosition, leavePlayback, play, stop, seekToTime, togglePlayPause, showStatus, initMediaSession, updateMediaSession, reportProgress, setPlayerCallbacks } from "./player.js";
import { loadBrowseScreen, openEpisodes, renderPlaylists, renderQueue, updateSubsUI, updateAudioUI, toggleSubtitle, showBrowseFromEpisodes } from "./browse.js";
import { loadSubtitleTrack, disableExternalSubtitle } from "./subtitles.js";
import { plexPlaybackRequest, requestPlexPlayback } from "./plex-preferences.js";
import { requestJson } from "./network.js";

const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
const connectionStatus = document.getElementById("connection-status");
const connectionStatusText = document.getElementById("connection-status-text");
let reconnectTimer = null;
let lastWsActivityAt = 0;
const WS_RECONNECT_DELAY_MS = 3_000;
const WS_BUSY_RECONNECT_DELAY_MS = 15_000;
const WS_STALE_AFTER_MS = 70_000;
const WS_HEALTH_CHECK_INTERVAL_MS = 15_000;
const PLAYER_CONNECTION_ID = getPlayerConnectionId();

function getPlayerConnectionId() {
  const storageKey = "drivein-player-connection-id";
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored) return stored;
    const generated = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(storageKey, generated);
    return generated;
  } catch {
    return `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

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

let routeTransitionGeneration = 0;

initRouter((route, navigation) => {
  const generation = ++routeTransitionGeneration;
  if (route.view === "browse") {
    void enterBrowseRoute(generation).catch((error) => {
      console.error("[router] Failed to enter browse route:", error);
      if (generation === routeTransitionGeneration) {
        showStatus(`Failed to load home screen: ${error.message}`);
      }
    });
    return;
  }
  if (route.view === "show" && navigation?.source === "popstate") {
    void enterShowRoute(route, generation).catch((error) => {
      console.error("[router] Failed to enter show route:", error);
      if (generation === routeTransitionGeneration) {
        showStatus(`Failed to load show: ${error.message}`);
      }
    });
  }
  // Push navigation to player/show is completed by the action that initiated it.
});

async function enterBrowseRoute(generation) {
  await leavePlayback();
  if (generation !== routeTransitionGeneration || parseRoute().view !== "browse") return;
  await loadBrowseScreen();
}

async function enterShowRoute(route, generation) {
  await leavePlayback();
  const isCurrent = () => {
    const currentRoute = parseRoute();
    return generation === routeTransitionGeneration
      && currentRoute.view === "show"
      && String(currentRoute.ratingKey) === String(route.ratingKey);
  };
  if (!isCurrent()) return;
  const browseData = await loadBrowseScreen();
  if (!isCurrent()) return;
  const show = browseData.shows.find((item) => String(item.ratingKey) === String(route.ratingKey));
  if (!show) {
    navigate("/", true);
    showStatus("Show not found");
    return;
  }
  await openEpisodes(show, { updateRoute: false, isCurrent });
}

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

async function restoreConnectedRoute({
  forcePlaybackRestore = false,
  playbackSnapshot = null,
} = {}) {
  const route = parseRoute();
  if (!forcePlaybackRestore && (state.player || state.isPlaying)) return;

  // Page refresh on /play?url=... or /play?plex=... — re-trigger playback
  if (route.view === "player" && (route.url || route.plex)) {
    const localResumeTime = getPlaybackPosition();
    const serverResumeTime = Math.max(0, Number(playbackSnapshot?.currentTime) || 0);
    const resumeTime = !state.isLive
      ? forcePlaybackRestore ? localResumeTime : serverResumeTime
      : 0;
    const autoplay = forcePlaybackRestore
      ? state.playbackIntent === "playing"
      : playbackSnapshot ? playbackSnapshot.playbackIntent === "playing" : true;
    showStatus(forcePlaybackRestore
      ? "Restoring playback after server restart..."
      : "Resuming playback...");
    const endpoint = route.plex ? "/api/plex/play" : "/api/play";
    const body = route.plex
      ? plexPlaybackRequest(route.plex, {
          ...(resumeTime > 0 ? { offset: resumeTime * 1000 } : {}),
          recovery: forcePlaybackRestore,
          autoplay,
        })
      : {
          url: route.url,
          ...(resumeTime > 0 ? { startTime: resumeTime } : {}),
          autoplay,
          reason: forcePlaybackRestore ? "server-restart" : "resume-route",
        };
    const playbackRequest = route.plex
      ? requestPlexPlayback(body)
      : requestJson(`${location.origin}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, { label: "Resume playback", timeoutMs: 90_000 }).then(async (response) => {
        if (response.ok) return response;
        const result = response.data || {};
        throw new Error(result.error || `Playback failed with ${response.status}`);
      });
    playbackRequest.catch((error) => {
      console.error("[playback] Resume failed:", error);
      showStatus(`Playback error: ${error.message}`);
      if (forcePlaybackRestore) return;
      navigate("/", true);
    });
    return;
  }

  const browseData = await loadBrowseScreen();
  if (route.view === "show") {
    const show = browseData.shows.find((item) => String(item.ratingKey) === String(route.ratingKey));
    if (show) await openEpisodes(show, { updateRoute: false });
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
  const wsUrl = `${proto}//${location.host}/ws?role=player&clientId=${encodeURIComponent(PLAYER_CONNECTION_ID)}`;
  const ws = new WebSocket(wsUrl);
  let accepted = false;

  state.ws = ws;
  lastWsActivityAt = Date.now();

  ws.onopen = () => {
    if (state.ws !== ws) return;
    console.log("[ws] Socket opened, waiting for player lease");
    lastWsActivityAt = Date.now();
    showConnectionStatus("Connecting…");
  };

  ws.onmessage = (e) => {
    if (state.ws !== ws) return;
    lastWsActivityAt = Date.now();
    try {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data);

      if (msg.type === "playerAccepted") {
        if (accepted) return;
        accepted = true;
        console.log("[ws] Connected");
        hideConnectionStatus();
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        syncPlayerConnection(ws);
        restoreConnectedRoute({
          forcePlaybackRestore: msg.playbackAvailable === false,
          playbackSnapshot: msg.playbackSnapshot || null,
        }).catch((error) => {
          console.error("[ws] Failed to restore route:", error);
          showStatus(`Connection restored, but the page failed to load: ${error.message}`);
        });
        return;
      }
      if (msg.type === "playerRejected") {
        showConnectionStatus("Another player is active");
        return;
      }
      if (!accepted) return;

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
            streamProfile: msg.streamProfile || null,
            autoplay: msg.autoplay !== false,
            __recovery: msg.recovery === true,
          }).catch((error) => console.error("[playback] Play transition failed:", error));
          break;
        case "pause":
          state.playbackIntent = "paused";
          if (state.player) {
            state.player.pause().catch(() => {});
          }
          state.isPlaying = false;
          updatePlayButton();
          break;
        case "resume":
          state.playbackIntent = "playing";
          if (state.player) {
            state.player.play().catch(() => {});
          }
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

  ws.onclose = (event) => {
    if (state.ws !== ws) return;
    state.ws = null;
    const busy = event.code === 4009;
    console.log(busy
      ? "[ws] Another player is active; retrying later..."
      : "[ws] Disconnected, reconnecting in 3s...");
    showConnectionStatus(busy ? "Another player is active" : "Reconnecting…");
    if (!state.player && !state.isPlaying) {
      showStatus(busy ? "Another player is active" : "Reconnecting…");
    }
    scheduleReconnect(busy ? WS_BUSY_RECONNECT_DELAY_MS : WS_RECONNECT_DELAY_MS);
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
