import { state } from "./state.js";
import { plexPlaybackRequest, requestPlexPlayback } from "./plex-preferences.js";
import { fmt, timeAgo, escHtml } from "./utils.js";
import { navigate } from "./router.js";
import { showStatus } from "./player.js";
import { loadSubtitleTrack, disableExternalSubtitle, removeSubtitleTrack } from "./subtitles.js";
import { requestJson, requestJsonData, requestOk } from "./network.js";

function escAttr(value) {
  return escHtml(String(value || "")).replace(/"/g, "&quot;");
}

// --- DOM elements ----------------------------------------------------

const browseScreen = document.getElementById("browse-screen");
const queueSection = document.getElementById("queue-section");
const queueList = document.getElementById("queue-list");
const queueClear = document.getElementById("queue-clear");
const playlistsSection = document.getElementById("playlists-section");
const playlistsList = document.getElementById("playlists-list");
const historySection = document.getElementById("history-section");
const historyList = document.getElementById("history-list");
const moviesSection = document.getElementById("movies-section");
const moviesList = document.getElementById("movies-list");
const showsSection = document.getElementById("shows-section");
const showsList = document.getElementById("shows-list");
const statusScreen = document.getElementById("status-screen");
const episodesSection = document.getElementById("episodes-section");
const episodesList = document.getElementById("episodes-list");
const epsShowTitle = document.getElementById("eps-show-title");
const btnSubs = document.getElementById("btn-subs");
const subsPanel = document.getElementById("subs-panel");
const subsList = document.getElementById("subs-list");
const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
const audioList = document.getElementById("audio-list");

// --- Subtitle label formatting (based on actual Plex library data) ---

function formatSubtitleLabel(sub) {
  const t = (sub.title || "").trim();
  const low = t.toLowerCase();

  // Chinese: detect variant from title field
  if (sub.languageCode === "zho" || sub.language === "中文" || (sub.displayTitle || "").includes("中文")) {
    const hasChs = /chs|简体|简中|simplified/i.test(t);
    const hasCht = /cht|繁体|繁中|traditional/i.test(t);
    const hasEng = /eng|english|英/i.test(t);
    const hasEffect = /特效/i.test(t);
    const isForced = /forced|强制/i.test(t) || (sub.displayTitle || "").includes("Forced");

    let label = "中文";
    if (hasChs && hasEng) label = "简英双语";
    else if (hasCht && hasEng) label = "繁英双语";
    else if (hasEng) label = "中英双语";
    else if (hasChs) label = "简体中文";
    else if (hasCht) label = "繁体中文";

    if (hasEffect) label += "（特效）";
    if (isForced) label += "（强制）";
    return label;
  }

  // Non-Chinese: use displayTitle (Plex already localizes well), add flags from title
  let label = sub.displayTitle || sub.language || t || "Unknown";
  const isSDH = /sdh/i.test(t) || (sub.displayTitle || "").includes("SDH");
  const isForced = /forced/i.test(t) || (sub.displayTitle || "").includes("Forced");
  const isSigns = /signs/i.test(t);

  // Avoid duplicating flags already in displayTitle
  const flags = [];
  if (isSDH && !label.includes("SDH")) flags.push("SDH");
  if (isForced && !label.includes("Forced") && !label.includes("强制")) flags.push("强制");
  if (isSigns) flags.push("标识");
  if (flags.length) label += ` (${flags.join(", ")})`;

  return label;
}

// --- Subtitle selection UI -------------------------------------------

export function updateSubsUI() {
  const hasPlex = state.plexInfo?.subtitles?.length > 0;
  const hasExternal = state.externalSubs.length > 0;

  if (!hasPlex && !hasExternal) {
    btnSubs.classList.add("hidden");
    subsPanel.classList.add("hidden");
    return;
  }
  btnSubs.classList.remove("hidden");

  const hasActive = hasPlex ? !!state.plexInfo.activeSubtitleID : state.activeExternalSubs.size > 0;
  btnSubs.classList.toggle("active", hasActive);

  subsList.innerHTML = "";

  const offBtn = document.createElement("button");
  offBtn.textContent = "Off";
  if (!hasActive) offBtn.classList.add("active");
  offBtn.addEventListener("click", (e) => { e.stopPropagation(); selectSubtitle(null); });
  subsList.appendChild(offBtn);

  if (hasPlex) {
    for (const sub of state.plexInfo.subtitles) {
      const btn = document.createElement("button");
      const label = formatSubtitleLabel(sub);
      btn.innerHTML = `<span>${escHtml(label)}</span>`;
      if (String(state.plexInfo.activeSubtitleID) === String(sub.id)) btn.classList.add("active");
      btn.addEventListener("click", (e) => { e.stopPropagation(); selectSubtitle(sub.id); });
      subsList.appendChild(btn);
    }
  } else {
    for (const sub of state.externalSubs) {
      const btn = document.createElement("button");
      const label = `${sub.name}${sub.auto ? " (auto)" : ""}`;
      btn.innerHTML = `<span>${escHtml(label)}</span>`;
      if (state.activeExternalSubs.has(sub.lang)) btn.classList.add("active");
      btn.addEventListener("click", (e) => { e.stopPropagation(); toggleSubtitle(sub.lang); });
      subsList.appendChild(btn);
    }
  }
}

function selectSubtitle(id) {
  subsPanel.classList.add("hidden");

  if (state.plexInfo?.subtitles?.length) {
    const sub = state.plexInfo.subtitles.find((s) => String(s.id) === String(id));
    if (sub) {
      const preference = sub.language || sub.languageCode || sub.displayTitle;
      localStorage.setItem("preferred-sub-langs", JSON.stringify([preference]));
    } else {
      localStorage.removeItem("preferred-sub-langs");
    }

    const activeSub = state.plexInfo.subtitles.find((candidate) => (
      String(candidate.id) === String(state.plexInfo.activeSubtitleID)
    ));
    const canSwitchWithoutTranscode = (!activeSub || activeSub.delivery === "external")
      && (!sub || sub.delivery === "external");
    if (canSwitchWithoutTranscode) {
      disableExternalSubtitle();
      state.plexInfo.activeSubtitleID = sub?.id || null;
      updateSubsUI();
      if (sub?.url) {
        loadSubtitleTrack(`plex:${sub.id}`, sub.url).then((loaded) => {
          if (loaded) return;
          showStatus("Text subtitle failed. Falling back to Plex burn-in...");
          requestPlexPlayback({
            ratingKey: state.plexInfo.ratingKey,
            subtitleStreamID: sub.id,
            offset: Math.floor(state.currentTime * 1000),
          }).catch((err) => {
            console.error("[subs] Fallback error:", err);
            showStatus(`Subtitle error: ${err.message}`);
          });
        });
      }
      return;
    }

    const offsetMs = Math.floor(state.currentTime * 1000);
    requestPlexPlayback({
      ratingKey: state.plexInfo.ratingKey,
      subtitleStreamID: id,
      offset: offsetMs,
    }).catch((err) => {
      console.error("[subs] Error:", err);
      showStatus(`Plex error: ${err.message}`);
    });
  } else {
    state.activeExternalSubs.clear();
    disableExternalSubtitle();
    localStorage.removeItem("preferred-sub-langs");
    updateSubsUI();
  }
}

export function toggleSubtitle(lang) {
  if (state.activeExternalSubs.has(lang)) {
    state.activeExternalSubs.delete(lang);
    // Remove track handled by subtitles module
    removeSubtitleTrack(lang);
  } else {
    state.activeExternalSubs.add(lang);
    const sub = state.externalSubs.find((s) => s.lang === lang);
    if (sub) {
      requestJsonData(`${location.origin}/api/subtitles/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang }),
      }, { label: "Subtitle selection" }).then((data) => {
        if (data.url) loadSubtitleTrack(lang, data.url);
      }).catch((err) => console.error("[subs] Error:", err));
    }
  }
  localStorage.setItem("preferred-sub-langs", JSON.stringify([...state.activeExternalSubs]));
  updateSubsUI();
}

// --- Audio track selection -------------------------------------------

export function updateAudioUI() {
  const hasTrackSelection = state.plexInfo?.audioTracks?.length > 1;
  const hasBoostControl = !!state.player;

  if (!hasTrackSelection && !hasBoostControl) {
    btnAudio.classList.add("hidden");
    audioPanel.classList.add("hidden");
    return;
  }
  btnAudio.classList.remove("hidden");

  audioList.innerHTML = "";
  if (!hasTrackSelection) return;

  for (const track of state.plexInfo.audioTracks) {
    const btn = document.createElement("button");
    const codec = (track.codec || "").toUpperCase();
    const ch = track.channels ? `${track.channels}ch` : "";
    const label = track.displayTitle || track.language || "Unknown";
    const detail = [codec, ch].filter(Boolean).join(" ");
    btn.innerHTML = `<span>${escHtml(label)}</span>${detail ? `<small>${escHtml(detail)}</small>` : ""}`;
    const isActive = state.plexInfo.activeAudioID
      ? String(state.plexInfo.activeAudioID) === String(track.id)
      : track.selected;
    if (isActive) btn.classList.add("active");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectAudioTrack(track.id);
    });
    audioList.appendChild(btn);
  }
}

function selectAudioTrack(audioId) {
  audioPanel.classList.add("hidden");
  if (!state.plexInfo) return;
  const track = state.plexInfo.audioTracks?.find((t) => String(t.id) === String(audioId));
  if (track?.language) {
    localStorage.setItem("preferred-audio-lang", track.language);
  }
  const offsetMs = Math.floor(state.currentTime * 1000);
  requestPlexPlayback({
    ratingKey: state.plexInfo.ratingKey,
    audioStreamID: audioId,
    subtitleStreamID: state.plexInfo.activeSubtitleID || undefined,
    offset: offsetMs,
  }).catch((err) => {
    console.error("[audio] Error:", err);
    showStatus(`Plex error: ${err.message}`);
  });
}

// --- Browse screen ---------------------------------------------------

export async function loadBrowseScreen() {
  const [queueRes, playlistsRes, historyRes, libsRes] = await Promise.allSettled([
    requestJsonData(`${location.origin}/api/queue`, {}, { label: "Queue" }),
    requestJsonData(`${location.origin}/api/playlists`, {}, { label: "Playlists" }),
    requestJsonData(`${location.origin}/api/history`, {}, { label: "History" }),
    requestJsonData(`${location.origin}/api/plex/libraries`, {}, { label: "Plex libraries" }),
  ]);

  const queue = queueRes.status === "fulfilled" ? queueRes.value : [];
  const playlists = playlistsRes.status === "fulfilled" ? playlistsRes.value : [];
  const history = historyRes.status === "fulfilled" ? historyRes.value : [];
  const libs = libsRes.status === "fulfilled" ? libsRes.value : [];

  let hasContent = false;

  if (queue.length) {
    renderQueue(queue);
    queueSection.classList.remove("hidden");
    hasContent = true;
  } else {
    renderQueue([]);
    queueSection.classList.add("hidden");
  }

  if (playlists.length) {
    renderPlaylists(playlists);
    playlistsSection.classList.remove("hidden");
    hasContent = true;
  } else {
    renderPlaylists([]);
    playlistsSection.classList.add("hidden");
  }

  if (history.length) {
    renderCardRow(historyList, history, { type: "history" });
    historySection.classList.remove("hidden");
    hasContent = true;
  } else {
    historySection.classList.add("hidden");
  }

  const movieLib = libs.find((l) => l.type === "movie");
  const showLib = libs.find((l) => l.type === "show");

  const [moviesRes, showsRes] = await Promise.allSettled([
    movieLib ? requestJsonData(`${location.origin}/api/plex/library/${movieLib.id}?size=0`, {}, { label: "Plex movies" }) : Promise.resolve(null),
    showLib ? requestJsonData(`${location.origin}/api/plex/library/${showLib.id}?size=0`, {}, { label: "Plex shows" }) : Promise.resolve(null),
  ]);

  if (moviesRes.status === "fulfilled" && moviesRes.value?.items?.length) {
    renderCardRow(moviesList, moviesRes.value.items, { type: "plex-movie" });
    moviesSection.classList.remove("hidden");
    hasContent = true;
  } else {
    moviesSection.classList.add("hidden");
  }

  const shows = showsRes.status === "fulfilled" ? showsRes.value?.items || [] : [];
  if (shows.length) {
    renderCardRow(showsList, shows, { type: "plex-show" });
    showsSection.classList.remove("hidden");
    hasContent = true;
  } else {
    showsSection.classList.add("hidden");
  }

  if (hasContent) {
    browseScreen.classList.remove("hidden");
    statusScreen.style.display = "none";
  } else {
    browseScreen.classList.add("hidden");
    statusScreen.style.display = "";
    showStatus("Waiting for content...");
  }

  // Reset episodes view
  episodesSection.classList.add("hidden");
  return { shows };
}

// --- Playlist rendering ----------------------------------------------

export function renderPlaylists(playlists = []) {
  state.playlists = playlists;
  if (!playlistsSection || !playlistsList) return;
  playlistsList.innerHTML = "";
  const episodesOpen = episodesSection && !episodesSection.classList.contains("hidden");
  playlistsSection.classList.toggle("hidden", playlists.length === 0 || episodesOpen);

  playlists.forEach((playlist) => {
    const el = document.createElement("div");
    el.className = "browse-card playlist-card";
    const thumbHtml = playlist.thumbnail
      ? `<img src="${escAttr(playlist.thumbnail)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'playlist-card-icon',innerHTML:'<svg viewBox=\\'0 0 24 24\\' fill=\\'white\\' width=\\'30\\' height=\\'30\\'><path d=\\'M4 6h14v2H4V6zm0 5h14v2H4v-2zm0 5h10v2H4v-2zm16-7v10l-7-5 7-5z\\'/></svg>'}))">`
      : `<div class="playlist-card-icon"><svg viewBox="0 0 24 24" fill="white" width="30" height="30"><path d="M4 6h14v2H4V6zm0 5h14v2H4v-2zm0 5h10v2H4v-2zm16-7v10l-7-5 7-5z"/></svg></div>`;
    const meta = [
      `${playlist.itemCount || 0} item${playlist.itemCount === 1 ? "" : "s"}`,
      playlist.duration ? fmt(playlist.duration) : null,
    ].filter(Boolean).join(" \u00B7 ");
    el.innerHTML = `
      <div class="browse-card-thumb playlist-card-thumb">
        ${thumbHtml}
        <div class="playlist-play-badge">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
      <div class="browse-card-title">${escHtml(playlist.name)}</div>
      ${meta ? `<div class="browse-card-meta">${meta}</div>` : ""}
    `;
    el.addEventListener("click", () => enqueuePlaylist(playlist.id));
    playlistsList.appendChild(el);
  });
}

async function enqueuePlaylist(id) {
  try {
    const { ok, data } = await requestJson(
      `${location.origin}/api/playlists/${encodeURIComponent(id)}/enqueue`,
      { method: "POST" },
      { label: "Enqueue playlist" },
    );
    if (!ok) return;
    if (data.queue) renderQueue(data.queue);
  } catch (err) {
    console.error("[playlist] Enqueue failed:", err);
  }
}

// --- Queue rendering -------------------------------------------------

export function renderQueue(queue = []) {
  state.queue = queue;
  if (!queueSection || !queueList) return;
  queueList.innerHTML = "";
  queueClear?.classList.toggle("hidden", queue.length === 0);
  const episodesOpen = episodesSection && !episodesSection.classList.contains("hidden");
  queueSection.classList.toggle("hidden", queue.length === 0 || episodesOpen);

  queue.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = "browse-card queue-card";
    const thumbHtml = item.thumbnail
      ? `<img src="${escAttr(item.thumbnail)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'browse-card-thumb-empty',innerHTML:'<svg viewBox=\\'0 0 24 24\\' fill=\\'white\\' width=\\'28\\' height=\\'28\\'><path d=\\'M8 5v14l11-7z\\'/></svg>'}))">`
      : `<div class="browse-card-thumb-empty"><svg viewBox="0 0 24 24" fill="white" width="28" height="28"><path d="M8 5v14l11-7z"/></svg></div>`;
    const meta = [
      item.sourceType === "plex" ? "Plex" : "URL",
      item.duration ? fmt(item.duration) : null,
    ].filter(Boolean).join(" \u00B7 ");
    el.innerHTML = `
      <div class="browse-card-thumb">
        ${thumbHtml}
        <div class="queue-position">${index + 1}</div>
        <button class="queue-remove" type="button" aria-label="Remove from queue">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="browse-card-title">${escHtml(item.title)}</div>
      ${meta ? `<div class="browse-card-meta">${meta}</div>` : ""}
    `;
    el.querySelector(".queue-remove")?.addEventListener("click", (e) => {
      e.stopPropagation();
      removeQueueItem(item.id);
    });
    el.addEventListener("click", () => playQueueItem(item.id));
    queueList.appendChild(el);
  });
}

async function playQueueItem(id) {
  showStatus("Loading...");
  browseScreen.classList.add("hidden");
  statusScreen.style.display = "";
  try {
    await requestOk(
      `${location.origin}/api/queue/${encodeURIComponent(id)}/play`,
      { method: "POST" },
      { label: "Play queue item", timeoutMs: 90_000 },
    );
  } catch (err) {
    console.error("[queue] Play failed:", err);
  }
}

async function removeQueueItem(id) {
  const current = state.queue.slice();
  renderQueue(current.filter((item) => item.id !== id));
  try {
    const ok = await requestOk(`${location.origin}/api/queue/${encodeURIComponent(id)}`, { method: "DELETE" }, { label: "Remove queue item" });
    if (!ok) renderQueue(current);
  } catch (err) {
    renderQueue(current);
  }
}

queueClear?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const current = state.queue.slice();
  renderQueue([]);
  try {
    const ok = await requestOk(`${location.origin}/api/queue`, { method: "DELETE" }, { label: "Clear queue" });
    if (!ok) renderQueue(current);
  } catch {
    renderQueue(current);
  }
});

async function addToQueue(body, { playNext = false } = {}) {
  try {
    await requestOk(`${location.origin}/api/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, playNext }),
    }, { label: "Add to queue" });
  } catch (err) {
    console.error("[queue] Add failed:", err);
  }
}

function queuePayloadForItem(item, type) {
  if (type === "history") {
    if (item.plex?.ratingKey) {
      return {
        ratingKey: item.plex.ratingKey,
        title: item.title,
        thumbnail: item.thumbnail,
        duration: item.duration,
      };
    }
    if (item.url) {
      return {
        url: item.url,
        title: item.title,
        thumbnail: item.thumbnail,
        duration: item.duration,
      };
    }
  }
  if (type === "plex-movie") {
    return {
      ratingKey: item.ratingKey,
      title: item.title,
      thumbnail: item.thumb ? `/api/plex/thumb?path=${encodeURIComponent(item.thumb)}` : null,
      duration: item.duration ? item.duration * 60 : null,
    };
  }
  return null;
}

// --- Card rendering --------------------------------------------------

function renderCardRow(container, items, { type }) {
  container.innerHTML = "";
  for (const item of items) {
    const el = document.createElement("div");
    const isPoster = type === "plex-movie" || type === "plex-show";
    el.className = `browse-card${isPoster ? " poster" : ""}`;

    let thumbUrl = null;
    if (type === "history") thumbUrl = item.thumbnail;
    else if (item.thumb) thumbUrl = `/api/plex/thumb?path=${encodeURIComponent(item.thumb)}`;

    const thumbHtml = thumbUrl
      ? `<img src="${thumbUrl}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'browse-card-thumb-empty',innerHTML:'<svg viewBox=\\'0 0 24 24\\' fill=\\'white\\' width=\\'28\\' height=\\'28\\'><path d=\\'M8 5v14l11-7z\\'/></svg>'}))">`
      : `<div class="browse-card-thumb-empty"><svg viewBox="0 0 24 24" fill="white" width="28" height="28"><path d="M8 5v14l11-7z"/></svg></div>`;

    let meta = "";
    if (type === "history") {
      const parts = [];
      if (item.duration) parts.push(fmt(item.duration));
      parts.push(timeAgo(item.playedAt));
      meta = parts.join(" \u00B7 ");
    } else if (type === "plex-movie") {
      const parts = [];
      if (item.year) parts.push(item.year);
      if (item.duration) parts.push(`${item.duration}min`);
      meta = parts.join(" \u00B7 ");
    } else if (type === "plex-show") {
      meta = `${item.leafCount || 0} episodes`;
    }

    const isWatched = type === "plex-movie" ? item.viewCount > 0
      : type === "plex-show" ? (item.viewedLeafCount > 0 && item.viewedLeafCount >= item.leafCount)
      : type === "history" ? item.viewCount > 0
      : false;
    const badgeHtml = isWatched
      ? `<div class="watched-badge"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>`
      : "";

    let progressPct = 0;
    if (type === "history" && item.progress && item.duration) {
      progressPct = (item.progress / item.duration) * 100;
    } else if (item.viewOffset && item.duration) {
      const durationMs = type === "plex-movie" ? item.duration * 60000 : item.duration * 1000;
      progressPct = (item.viewOffset / durationMs) * 100;
    }
    const progressHtml = progressPct > 0
      ? `<div class="browse-card-progress-track"></div><div class="browse-card-progress" style="width:${Math.min(progressPct, 100).toFixed(1)}%"></div>`
      : "";

    el.innerHTML = `
      <div class="browse-card-thumb">${thumbHtml}${badgeHtml}${progressHtml}</div>
      <div class="browse-card-title">${escHtml(item.title)}</div>
      ${meta ? `<div class="browse-card-meta">${meta}</div>` : ""}
    `;

    const queuePayload = queuePayloadForItem(item, type);
    if (queuePayload) {
      const queueBtn = document.createElement("button");
      queueBtn.className = "browse-card-queue";
      queueBtn.type = "button";
      queueBtn.setAttribute("aria-label", "Add to queue");
      queueBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z"/></svg>`;
      queueBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        addToQueue(queuePayload);
      });
      el.querySelector(".browse-card-thumb").appendChild(queueBtn);
    }

    if (type === "history") {
      // Delete badge
      const delBtn = document.createElement("button");
      delBtn.className = "browse-card-delete";
      delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.add("deleted");
        pendingDeletes.push({ item, el });
      });
      el.appendChild(delBtn);

      // Undo overlay
      const undoBtn = document.createElement("div");
      undoBtn.className = "browse-card-undo";
      undoBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>`;
      undoBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.remove("deleted");
        const idx = pendingDeletes.findIndex((d) => d.el === el);
        if (idx !== -1) pendingDeletes.splice(idx, 1);
      });
      el.querySelector(".browse-card-thumb").appendChild(undoBtn);

      // Long-press for edit mode
      let pressTimer = null;
      el.addEventListener("pointerdown", () => {
        pressTimer = setTimeout(() => enterHistoryEditMode(), 600);
      });
      el.addEventListener("pointerup", () => clearTimeout(pressTimer));
      el.addEventListener("pointerleave", () => clearTimeout(pressTimer));
      el.addEventListener("pointercancel", () => clearTimeout(pressTimer));
      el.addEventListener("click", () => {
        if (historySection.classList.contains("edit-mode")) return;
        playItem(item);
      });
    } else {
      el.addEventListener("click", () => {
        if (type === "plex-movie") playPlexItem(item.ratingKey);
        else if (type === "plex-show") openEpisodes(item);
      });
    }
    container.appendChild(el);
  }
}

// --- History edit mode ------------------------------------------------

const pendingDeletes = [];

function enterHistoryEditMode() {
  if (historySection.classList.contains("edit-mode")) return;
  historySection.classList.add("edit-mode");
  const handler = (e) => {
    if (e.target.closest(".browse-card")) return;
    commitHistoryDeletes();
    historySection.classList.remove("edit-mode");
    document.removeEventListener("pointerdown", handler);
  };
  setTimeout(() => document.addEventListener("pointerdown", handler), 50);
}

function commitHistoryDeletes() {
  for (const { item, el } of pendingDeletes) {
    const key = item.plex?.ratingKey;
    const body = key ? { ratingKey: String(key) } : { url: item.url };
    requestOk(`${location.origin}/api/history`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, { label: "Delete history item" }).catch(() => {});
    el.remove();
  }
  pendingDeletes.length = 0;
  if (historyList.children.length === 0) {
    historySection.classList.add("hidden");
  }
}

// --- Play items ------------------------------------------------------

function playItem(item) {
  if (item.plex?.ratingKey) playPlexItem(item.plex.ratingKey);
  else if (item.url) {
    requestOk(`${location.origin}/api/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url }),
    }, { label: "Start playback", timeoutMs: 90_000 }).catch(() => {});
  }
  showStatus("Loading...");
  browseScreen.classList.add("hidden");
  statusScreen.style.display = "";
}

export function playPlexItem(ratingKey) {
  showStatus("Loading...");
  browseScreen.classList.add("hidden");
  statusScreen.style.display = "";
  requestPlexPlayback(plexPlaybackRequest(ratingKey)).catch((err) => {
    console.error("[plex] Playback error:", err);
    showStatus(`Plex error: ${err.message}`);
  });
}

// --- Episodes --------------------------------------------------------

export async function openEpisodes(show) {
  navigate(`/show/${show.ratingKey}`);
  epsShowTitle.textContent = show.title;
  episodesList.innerHTML = "";
  episodesSection.classList.remove("hidden");
  queueSection.classList.add("hidden");
  playlistsSection.classList.add("hidden");
  historySection.classList.add("hidden");
  moviesSection.classList.add("hidden");
  showsSection.classList.add("hidden");

  try {
    const eps = await requestJsonData(
      `${location.origin}/api/plex/show/${show.ratingKey}/episodes`,
      {},
      { label: "Plex episodes" },
    );

    const seasons = new Map();
    for (const ep of eps) {
      const s = ep.season || 1;
      if (!seasons.has(s)) seasons.set(s, []);
      seasons.get(s).push(ep);
    }

    for (const [seasonNum, seasonEps] of seasons) {
      const header = document.createElement("div");
      header.className = "season-header";
      header.textContent = `Season ${seasonNum}`;
      episodesList.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "season-grid";

      for (const [episodeIndex, ep] of seasonEps.entries()) {
        const el = document.createElement("div");
        el.className = "episode-card";

        const thumbUrl = ep.thumb ? `/api/plex/thumb?path=${encodeURIComponent(ep.thumb)}` : "";
        const thumbHtml = thumbUrl
          // Tesla Chromium can leave dynamically inserted lazy images dormant
          // when the episodes section was hidden during layout. Episode lists
          // are small and disk-cached, so eager loading is the reliable choice.
          ? `<img src="${thumbUrl}" alt="" loading="eager" decoding="async" fetchpriority="${episodeIndex < 4 ? "high" : "low"}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'browse-card-thumb-empty episode-thumb-empty',innerHTML:'<svg viewBox=\\'0 0 24 24\\' fill=\\'currentColor\\' width=\\'28\\' height=\\'28\\'><path d=\\'M8 5v14l11-7z\\'/></svg><span>Preview unavailable</span>'}))">`
          : `<div class="browse-card-thumb-empty episode-thumb-empty"><svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M8 5v14l11-7z"/></svg><span>Preview unavailable</span></div>`;
        const epWatched = ep.viewCount > 0;
        const epBadge = epWatched
          ? `<div class="watched-badge"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>`
          : "";
        const epProgress = (ep.viewOffset && ep.duration)
          ? `<div class="browse-card-progress-track"></div><div class="browse-card-progress" style="width:${Math.min((ep.viewOffset / (ep.duration * 60000)) * 100, 100).toFixed(1)}%"></div>`
          : "";

        const metaParts = [`E${ep.episode}`];
        if (ep.duration) metaParts.push(`${ep.duration}min`);

        el.innerHTML = `
          <div class="episode-card-thumb">${thumbHtml}${epBadge}${epProgress}</div>
          <div class="episode-card-title">${escHtml(ep.title)}</div>
          <div class="episode-card-meta">${metaParts.join(" \u00B7 ")}</div>
        `;
        const queueBtn = document.createElement("button");
        queueBtn.className = "browse-card-queue";
        queueBtn.type = "button";
        queueBtn.setAttribute("aria-label", "Add to queue");
        queueBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z"/></svg>`;
        queueBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          addToQueue({
            ratingKey: ep.ratingKey,
            title: `${show.title} S${ep.season}E${ep.episode} — ${ep.title}`,
            thumbnail: thumbUrl,
            duration: ep.duration ? ep.duration * 60 : null,
          });
        });
        el.querySelector(".episode-card-thumb").appendChild(queueBtn);

        el.addEventListener("click", () => playPlexItem(ep.ratingKey));
        grid.appendChild(el);
      }

      episodesList.appendChild(grid);
    }
  } catch (e) {
    console.error("[browse] Failed to load episodes:", e);
  }
}

export function showBrowseFromEpisodes() {
  episodesSection.classList.add("hidden");
  queueSection.classList.toggle("hidden", state.queue.length === 0);
  playlistsSection.classList.toggle("hidden", state.playlists.length === 0);
  historySection.classList.remove("hidden");
  moviesSection.classList.remove("hidden");
  showsSection.classList.remove("hidden");
  navigate("/");
}

// --- Scroll arrows ---------------------------------------------------

document.querySelectorAll(".browse-arrow").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const row = btn.closest(".browse-row-wrap").querySelector(".browse-row");
    const scrollAmount = row.clientWidth * 0.7;
    row.scrollBy({ left: btn.classList.contains("left") ? -scrollAmount : scrollAmount });
  });
});

// --- Episodes back button --------------------------------------------

document.getElementById("eps-back").addEventListener("click", () => {
  showBrowseFromEpisodes();
});
