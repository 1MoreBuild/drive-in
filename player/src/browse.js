import { state } from "./state.js";
import { fmt, timeAgo, escHtml } from "./utils.js";
import { navigate } from "./router.js";
import { showStatus } from "./player.js";
import { loadSubtitleTrack, disableExternalSubtitle, removeSubtitleTrack } from "./subtitles.js";

// --- DOM elements ----------------------------------------------------

const browseScreen = document.getElementById("browse-screen");
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
      const codec = (sub.codec || "").toUpperCase();
      const label = sub.displayTitle || sub.language || "Unknown";
      const mainText = codec ? `${label} (${codec})` : label;
      const subText = sub.title && sub.title !== sub.displayTitle ? sub.title : "";
      btn.innerHTML = `<span>${escHtml(mainText)}</span>${subText ? `<small>${escHtml(subText)}</small>` : ""}`;
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
      localStorage.setItem("preferred-sub-langs", JSON.stringify([sub.language]));
    } else {
      localStorage.removeItem("preferred-sub-langs");
    }
    const offsetMs = Math.floor(state.currentTime * 1000);
    fetch(`${location.origin}/api/plex/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratingKey: state.plexInfo.ratingKey, subtitleStreamID: id, offset: offsetMs }),
    }).catch((err) => console.error("[subs] Error:", err));
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
      fetch(`${location.origin}/api/subtitles/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang }),
      }).then((r) => r.json()).then((data) => {
        if (data.url) loadSubtitleTrack(lang, data.url);
      }).catch((err) => console.error("[subs] Error:", err));
    }
  }
  localStorage.setItem("preferred-sub-langs", JSON.stringify([...state.activeExternalSubs]));
  updateSubsUI();
}

// --- Audio track selection -------------------------------------------

export function updateAudioUI() {
  if (!state.plexInfo?.audioTracks?.length || state.plexInfo.audioTracks.length <= 1) {
    btnAudio.classList.add("hidden");
    audioPanel.classList.add("hidden");
    return;
  }
  btnAudio.classList.remove("hidden");

  audioList.innerHTML = "";
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
  fetch(`${location.origin}/api/plex/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ratingKey: state.plexInfo.ratingKey,
      audioStreamID: audioId,
      subtitleStreamID: state.plexInfo.activeSubtitleID || undefined,
      offset: offsetMs,
    }),
  }).catch((err) => console.error("[audio] Error:", err));
}

// --- Browse screen ---------------------------------------------------

export async function loadBrowseScreen() {
  const [historyRes, libsRes] = await Promise.allSettled([
    fetch(`${location.origin}/api/history`).then((r) => r.json()),
    fetch(`${location.origin}/api/plex/libraries`).then((r) => r.json()),
  ]);

  const history = historyRes.status === "fulfilled" ? historyRes.value : [];
  const libs = libsRes.status === "fulfilled" ? libsRes.value : [];

  let hasContent = false;

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
    movieLib ? fetch(`${location.origin}/api/plex/library/${movieLib.id}?size=0`).then((r) => r.json()) : Promise.resolve(null),
    showLib ? fetch(`${location.origin}/api/plex/library/${showLib.id}?size=0`).then((r) => r.json()) : Promise.resolve(null),
  ]);

  if (moviesRes.status === "fulfilled" && moviesRes.value?.items?.length) {
    renderCardRow(moviesList, moviesRes.value.items, { type: "plex-movie" });
    moviesSection.classList.remove("hidden");
    hasContent = true;
  } else {
    moviesSection.classList.add("hidden");
  }

  if (showsRes.status === "fulfilled" && showsRes.value?.items?.length) {
    renderCardRow(showsList, showsRes.value.items, { type: "plex-show" });
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
      ? `<img src="${thumbUrl}" alt="" loading="lazy">`
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
    fetch(`${location.origin}/api/history`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
    el.remove();
  }
  pendingDeletes.length = 0;
  if (historyList.children.length === 0) {
    historySection.classList.add("hidden");
  }
}

// --- Play items ------------------------------------------------------

export function playItem(item) {
  if (item.plex?.ratingKey) playPlexItem(item.plex.ratingKey);
  else if (item.url) {
    fetch(`${location.origin}/api/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url }),
    }).catch(() => {});
  }
  showStatus("Loading...");
  browseScreen.classList.add("hidden");
  statusScreen.style.display = "";
}

export function playPlexItem(ratingKey) {
  fetch(`${location.origin}/api/plex/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ratingKey }),
  }).catch(() => {});
  showStatus("Loading...");
  browseScreen.classList.add("hidden");
  statusScreen.style.display = "";
}

// --- Episodes --------------------------------------------------------

export async function openEpisodes(show) {
  navigate(`/show/${show.ratingKey}`);
  epsShowTitle.textContent = show.title;
  episodesList.innerHTML = "";
  episodesSection.classList.remove("hidden");
  historySection.classList.add("hidden");
  moviesSection.classList.add("hidden");
  showsSection.classList.add("hidden");

  try {
    const res = await fetch(`${location.origin}/api/plex/show/${show.ratingKey}/episodes`);
    const eps = await res.json();

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

      for (const ep of seasonEps) {
        const el = document.createElement("div");
        el.className = "episode-card";

        const thumbUrl = ep.thumb ? `/api/plex/thumb?path=${encodeURIComponent(ep.thumb)}` : "";
        const thumbHtml = thumbUrl
          ? `<img src="${thumbUrl}" alt="" loading="lazy">`
          : `<div class="browse-card-thumb-empty"><svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M8 5v14l11-7z"/></svg></div>`;
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
