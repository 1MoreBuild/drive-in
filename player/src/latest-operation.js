export class LatestOperation {
  constructor() {
    this.version = 0;
    this.tail = Promise.resolve();
  }

  run(operation) {
    const version = ++this.version;
    const isCurrent = () => version === this.version;
    const result = this.tail
      .catch(() => {})
      .then(async () => {
        if (!isCurrent()) return false;
        return operation({ isCurrent, version });
      });
    this.tail = result.catch(() => {});
    return result;
  }

  invalidate() {
    this.version += 1;
  }

  idle() {
    return this.tail;
  }
}
