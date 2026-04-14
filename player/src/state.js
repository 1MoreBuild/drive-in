// Shared mutable state — all modules import and read/write this directly.

export const state = {
  player: null,
  ws: null,
  playLock: false,
  audioUnlocked: false,
  isPlaying: false,
  isMuted: false,
  isBuffering: false,
  duration: 0,
  currentTime: 0,
  plexInfo: null,
  sourceUrl: null,       // original URL (YouTube/Bilibili) for the current playback
  progressInterval: null,
  externalSubs: [],
  activeExternalSubs: new Set(),
};
