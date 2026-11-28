export class KeyedOperationQueue {
  private readonly operations = new Map<string, Promise<unknown>>();

  /**
   * Keys with an operation running or queued. A key is dropped as soon as its
   * chain drains, so this only ever counts keys with work in flight.
   */
  get size(): number {
    return this.operations.size;
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve();
    const current = this.runAfter(previous, operation);
    this.operations.set(key, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(key) === current) this.operations.delete(key);
    }
  }

  private async runAfter<T>(previous: Promise<unknown>, operation: () => Promise<T>): Promise<T> {
    try {
      await previous;
    } catch {
      // An earlier failure must not prevent this key's next operation from running.
    }
    return operation();
  }
}
