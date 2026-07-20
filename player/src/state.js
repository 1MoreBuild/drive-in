// Shared mutable state — all modules import and read/write this directly.

export const state = {
  player: null,
  ws: null,
  audioUnlocked: false,
  isPlaying: false,
  isMuted: false,
  isBuffering: false,
  isLive: false,
  liveDvrAvailable: false,
  liveStartTime: 0,
  liveEdgeTime: 0,
  duration: 0,
  currentTime: 0,
  plexInfo: null,
  sourceUrl: null,       // original URL (YouTube/Bilibili) for the current playback
  queue: [],
  playlists: [],
  progressInterval: null,
  externalSubs: [],
  activeExternalSubs: new Set(),
};
