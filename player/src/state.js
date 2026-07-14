// Shared mutable state — all modules import and read/write this directly.

const DEFAULT_AUDIO_GAIN = 12.0;

export const state = {
  player: null,
  ws: null,
  playLock: false,
  audioUnlocked: false,
  audioGain: DEFAULT_AUDIO_GAIN,
  isPlaying: false,
  isMuted: false,
  isBuffering: false,
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
