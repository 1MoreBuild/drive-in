const PLAYER_STATUSES = new Map([
  ["idle", "idle"],
  ["loading", "resolving"],
  ["buffering", "playing"],
  ["playing", "playing"],
  ["paused", "paused"],
]);

function finiteNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
}

export function normalizePlayerStatus(value) {
  return PLAYER_STATUSES.get(String(value || "")) || null;
}

export function normalizePlayerState(message = {}) {
  const sourceViewport = message.viewport && typeof message.viewport === "object" ? message.viewport : null;
  const visual = sourceViewport?.visualViewport && typeof sourceViewport.visualViewport === "object"
    ? {
        width: finiteNumber(sourceViewport.visualViewport.width, { max: 20_000 }),
        height: finiteNumber(sourceViewport.visualViewport.height, { max: 20_000 }),
        scale: finiteNumber(sourceViewport.visualViewport.scale, { max: 20 }),
        offsetLeft: finiteNumber(sourceViewport.visualViewport.offsetLeft, { max: 20_000 }),
        offsetTop: finiteNumber(sourceViewport.visualViewport.offsetTop, { max: 20_000 }),
      }
    : null;
  const screen = sourceViewport?.screen && typeof sourceViewport.screen === "object"
    ? {
        width: finiteNumber(sourceViewport.screen.width, { max: 20_000 }),
        height: finiteNumber(sourceViewport.screen.height, { max: 20_000 }),
        availWidth: finiteNumber(sourceViewport.screen.availWidth, { max: 20_000 }),
        availHeight: finiteNumber(sourceViewport.screen.availHeight, { max: 20_000 }),
      }
    : null;
  const viewport = sourceViewport ? {
    innerWidth: finiteNumber(sourceViewport.innerWidth, { max: 20_000 }),
    innerHeight: finiteNumber(sourceViewport.innerHeight, { max: 20_000 }),
    devicePixelRatio: finiteNumber(sourceViewport.devicePixelRatio, { max: 20 }),
    devicePixelWidth: finiteNumber(sourceViewport.devicePixelWidth, { max: 100_000 }),
    devicePixelHeight: finiteNumber(sourceViewport.devicePixelHeight, { max: 100_000 }),
    visualViewport: visual,
    screen,
  } : null;
  return {
    currentTime: finiteNumber(message.currentTime),
    duration: finiteNumber(message.duration),
    isPlaying: message.isPlaying === true,
    isMuted: message.isMuted === true,
    plexRatingKey: message.plexRatingKey == null ? null : String(message.plexRatingKey).slice(0, 128),
    viewport,
  };
}
