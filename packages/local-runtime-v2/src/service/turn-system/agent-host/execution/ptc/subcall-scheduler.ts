import type { PtcToolExecutionMode } from './contracts.js';

interface QueuedCall<T> {
  readonly mode: PtcToolExecutionMode;
  readonly task: (signal: AbortSignal) => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly controller: AbortController;
  readonly removeAbortListener?: () => void;
  completion?: Promise<void>;
}

/**
 * A turn-local queue. A waiting sequential call blocks later parallel calls,
 * which lets writes become exclusive without allowing a read stream to starve
 * them forever.
 */
export class PtcSubcallScheduler {
  private readonly queue: QueuedCall<unknown>[] = [];
  private readonly active = new Set<QueuedCall<unknown>>();
  private readonly drainWaiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly maxConcurrent = 4) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('PtcSubcallScheduler requires at least one parallel slot.');
    }
  }

  run<T>(
    mode: PtcToolExecutionMode | undefined,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('PTC subcall scheduler is closed.'));
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error('PTC subcall cancelled.'));
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const item: QueuedCall<T> = {
        mode: mode ?? 'sequential',
        task,
        resolve,
        reject,
        controller,
        ...(signal
          ? {
              removeAbortListener: forwardAbort(signal, controller, () => {
                const index = this.queue.indexOf(item as QueuedCall<unknown>);
                if (index >= 0) {
                  this.queue.splice(index, 1);
                  reject(signal.reason ?? new Error('PTC subcall cancelled.'));
                  this.notifyDrained();
                  this.pump();
                }
              }),
            }
          : {}),
      };
      this.queue.push(item as QueuedCall<unknown>);
      this.pump();
    });
  }

  stop(reason: unknown = new Error('PTC subcall scheduler stopped.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      item.removeAbortListener?.();
      item.controller.abort(reason);
      item.reject(reason);
    }
    for (const item of this.active) item.controller.abort(reason);
    this.notifyDrained();
  }

  async drain(): Promise<void> {
    if (this.queue.length === 0 && this.active.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  private pump(): void {
    if (this.closed || this.activeSequential()) return;
    for (;;) {
      const next = this.queue[0];
      if (!next) {
        this.notifyDrained();
        return;
      }
      if (next.mode === 'sequential') {
        if (this.active.size > 0) return;
        this.start(this.queue.shift()!);
        return;
      }
      if (this.active.size >= this.maxConcurrent) return;
      this.start(this.queue.shift()!);
    }
  }

  private start(item: QueuedCall<unknown>): void {
    this.active.add(item);
    item.completion = this.executeTask(item);
  }

  private async executeTask(item: QueuedCall<unknown>): Promise<void> {
    try {
      if (item.controller.signal.aborted) throw item.controller.signal.reason;
      item.resolve(await item.task(item.controller.signal));
    } catch (error) {
      item.reject(error);
    } finally {
      item.removeAbortListener?.();
      this.active.delete(item);
      this.notifyDrained();
      this.pump();
    }
  }

  private activeSequential(): boolean {
    for (const item of this.active) if (item.mode === 'sequential') return true;
    return false;
  }

  private notifyDrained(): void {
    if (this.queue.length !== 0 || this.active.size !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

function forwardAbort(
  source: AbortSignal,
  target: AbortController,
  onAbort: () => void,
): () => void {
  const abort = () => {
    target.abort(source.reason);
    onAbort();
  };
  source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}
