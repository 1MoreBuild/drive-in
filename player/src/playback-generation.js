export class PlaybackGeneration {
  #current = 0;

  begin() {
    this.#current += 1;
    return this.#current;
  }

  cancel() {
    this.#current += 1;
  }

  isCurrent(generation) {
    return generation === this.#current;
  }
}
