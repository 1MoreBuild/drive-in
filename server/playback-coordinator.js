export class PlaybackSupersededError extends Error {
  constructor(reason = "Playback request was superseded") {
    super(reason);
    this.name = "PlaybackSupersededError";
    this.code = "PLAYBACK_SUPERSEDED";
    this.status = 409;
  }
}

export class PlaybackCoordinator {
  #generation = 0;
  #controller = null;

  begin(reason = "play") {
    this.#controller?.abort(new PlaybackSupersededError());
    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#controller = controller;
    return {
      generation,
      reason,
      signal: controller.signal,
      assertCurrent: () => {
        if (generation !== this.#generation || controller.signal.aborted) {
          throw new PlaybackSupersededError();
        }
      },
    };
  }

  cancel(reason = "Playback stopped") {
    this.#generation += 1;
    this.#controller?.abort(new PlaybackSupersededError(reason));
    this.#controller = null;
  }
}

export function isPlaybackSuperseded(error) {
  return error?.code === "PLAYBACK_SUPERSEDED" || error?.name === "AbortError";
}
