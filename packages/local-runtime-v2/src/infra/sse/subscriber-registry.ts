import { measureValue } from './bounded-ring.js';

class SubscriberOverflowError extends Error {
  override readonly name = 'SubscriberOverflowError';

  constructor(
    readonly droppedItems: number,
    readonly droppedBytes: number,
  ) {
    super(`SSE subscriber overflow: ${droppedItems} items / ${droppedBytes} bytes`);
  }
}

export interface SubscriberOptions<T> {
  readonly filter?: (value: T) => boolean;
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

export interface SubscriberRegistryOptions {
  readonly maxItems?: number;
  readonly maxBytes?: number;
  readonly measure?: (value: unknown) => number;
}

interface QueuedValue<T> {
  readonly value: T;
  readonly byteSize: number;
}

interface PendingRead<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

interface StreamSubscriptionLimits<T> {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly filter?: (value: T) => boolean;
}

const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_BYTES = 512 * 1_024;

export class StreamSubscription<T> implements AsyncIterableIterator<T> {
  private readonly queue: QueuedValue<T>[] = [];
  private pending?: PendingRead<T>;
  private filter?: (value: T) => boolean;
  private queuedBytes = 0;
  private terminalError?: unknown;
  private closed = false;
  private completed = false;
  private readonly maxItems: number;
  private readonly maxBytes: number;

  constructor(
    private readonly registry: SubscriberRegistry<T>,
    readonly id: string,
    limits: StreamSubscriptionLimits<T>,
  ) {
    this.maxItems = limits.maxItems;
    this.maxBytes = limits.maxBytes;
    this.filter = limits.filter;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.terminalError) {
      const error = this.terminalError;
      this.terminalError = undefined;
      return Promise.reject(error);
    }
    const queued = this.queue.shift();
    if (queued) {
      this.queuedBytes -= queued.byteSize;
      return Promise.resolve({ done: false, value: queued.value });
    }
    if (this.closed || this.completed) return Promise.resolve({ done: true, value: undefined });
    if (this.pending) return Promise.reject(new Error('Concurrent subscription reads are invalid'));
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  setFilter(filter: (value: T) => boolean): void {
    if (this.closed || this.completed) return;
    this.filter = filter;
    const retained = this.queue.filter(({ value }) => filter(value));
    this.queue.length = 0;
    this.queue.push(...retained);
    this.queuedBytes = retained.reduce((total, entry) => total + entry.byteSize, 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.registry.remove(this.id);
    this.pending?.resolve({ done: true, value: undefined });
    this.pending = undefined;
  }

  complete(): void {
    if (this.closed || this.completed) return;
    this.completed = true;
    this.registry.remove(this.id);
    this.pending?.resolve({ done: true, value: undefined });
    this.pending = undefined;
  }

  push(value: T, byteSize: number): void {
    if (this.closed || this.completed || (this.filter && !this.filter(value))) return;
    if (this.pending) {
      this.pending.resolve({ done: false, value });
      this.pending = undefined;
      return;
    }
    if (this.queue.length + 1 > this.maxItems || this.queuedBytes + byteSize > this.maxBytes) {
      this.overflow(byteSize);
      return;
    }
    this.queue.push({ value, byteSize });
    this.queuedBytes += byteSize;
  }

  private overflow(incomingBytes: number): void {
    const droppedItems = this.queue.length + 1;
    const droppedBytes = this.queuedBytes + incomingBytes;
    this.terminalError = new SubscriberOverflowError(droppedItems, droppedBytes);
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.registry.remove(this.id);
    if (this.pending) {
      this.pending.reject(this.terminalError);
      this.terminalError = undefined;
      this.pending = undefined;
    }
  }
}

export class SubscriberRegistry<T> {
  private readonly subscribers = new Map<string, StreamSubscription<T>>();
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly measure: (value: unknown) => number;
  private sequence = 0;

  constructor(options: SubscriberRegistryOptions = {}) {
    this.maxItems = normalizeLimit(options.maxItems, DEFAULT_MAX_ITEMS);
    this.maxBytes = normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES);
    this.measure = options.measure ?? measureValue;
  }

  subscribe(options: SubscriberOptions<T> = {}): StreamSubscription<T> {
    const id = `subscriber-${++this.sequence}`;
    const subscription = new StreamSubscription(this, id, {
      maxItems: normalizeLimit(options.maxItems, this.maxItems),
      maxBytes: normalizeLimit(options.maxBytes, this.maxBytes),
      ...(options.filter ? { filter: options.filter } : {}),
    });
    this.subscribers.set(id, subscription);
    return subscription;
  }

  publish(value: T, byteSize = this.measure(value)): void {
    const normalizedSize = Number.isFinite(byteSize) && byteSize >= 0 ? Math.floor(byteSize) : 0;
    this.subscribers.forEach((subscriber) => subscriber.push(value, normalizedSize));
  }

  close(): void {
    [...this.subscribers.values()].forEach((subscriber) => subscriber.close());
  }

  remove(id: string): void {
    this.subscribers.delete(id);
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
