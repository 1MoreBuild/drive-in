import { state } from "./state.js";
import { initRouter, parseRoute, navigate } from "./router.js";
import { initControls, updatePlayButton, updateVolumeButton } from "./controls.js";
import { play, stop, seekToTime, togglePlayPause, showStatus, initMediaSession, updateMediaSession, reportProgress, setPlayerCallbacks } from "./player.js";
import { loadBrowseScreen, updateSubsUI, updateAudioUI, toggleSubtitle, showBrowseFromEpisodes } from "./browse.js";
import { loadSubtitleTrack, disableExternalSubtitle } from "./subtitles.js";

const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
let reconnectTimer = null;

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

function unlockAudio() {
  if (state.audioUnlocked) return;
  state.audioUnlocked = true;
  document.removeEventListener("click", unlockAudio);
  document.removeEventListener("touchstart", unlockAudio);
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
}

document.addEventListener("click", unlockAudio);
document.addEventListener("touchstart", unlockAudio);

// --- MediaSession ----------------------------------------------------

initMediaSession();

// --- WebSocket -------------------------------------------------------

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/ws?role=player`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log("[ws] Connected");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // On initial load (no active player), redirect /play to browse since playback context is lost on refresh.
    // On reconnect during active playback, stay on the current view.
    if (!state.player && !state.isPlaying) {
      const route = parseRoute();
      if (route.view === "player") navigate("/", true);
      loadBrowseScreen();
    }
  };

  state.ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);

      if (msg.type === "ping") {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        }
        return;
      }

      // Skip per-message DOM lookups and noisy ping logs to reduce steady-state GC churn on Tesla.
      console.log("[ws] Received:", msg.type);

      switch (msg.type) {
        case "play":
          state.externalSubs = [];
          state.activeExternalSubs.clear();
          btnAudio.classList.add("hidden");
          audioPanel.classList.add("hidden");
          showStatus(`Loading: ${msg.title || "..."}`);
          // Auto-select Plex subtitle and audio from saved preferences
          if (msg.plex?.ratingKey && !msg.plex.activeSubtitleID && !msg.plex.activeAudioID) {
            try {
              const subPrefs = JSON.parse(localStorage.getItem("preferred-sub-langs") || "[]");
              const audioLang = localStorage.getItem("preferred-audio-lang");
              const subMatch = subPrefs.length && msg.plex.subtitles?.find((s) => subPrefs.includes(s.language));
              const audioMatch = audioLang && msg.plex.audioTracks?.find((t) => t.language === audioLang && !t.selected);
              if (subMatch || audioMatch) {
                fetch(`${location.origin}/api/plex/play`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    ratingKey: msg.plex.ratingKey,
                    ...(subMatch ? { subtitleStreamID: subMatch.id } : {}),
                    ...(audioMatch ? { audioStreamID: audioMatch.id } : {}),
                  }),
                }).catch(() => {});
                break;
              }
            } catch {}
          }
          play(msg.url, msg.title, {
            isLive: msg.isLive,
            duration: msg.duration || 0,
            plex: msg.plex || null,
            startTime: msg.startTime || 0,
          });
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
          stop();
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
          }
          updateSubsUI();
          break;
        case "reload":
          location.reload();
          return;
      }
    } catch (err) {
      console.error("[ws] Parse error:", err);
    }
  };

  state.ws.onclose = () => {
    console.log("[ws] Disconnected, reconnecting in 3s...");
    showStatus("Disconnected. Reconnecting...");
    // Keep only one reconnect timer alive so repeated close/error events do not stack work.
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 3000);
    }
  };

  state.ws.onerror = () => {
    state.ws.close();
  };
}

connect();
