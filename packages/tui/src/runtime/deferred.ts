import { randomUUID } from 'node:crypto';
import type { TuiRuntime } from './port.js';

const ASYNC_GENERATOR_METHODS = new Set([
  'sendMessage',
  'watchEvents',
  'watchSessionTurn',
  'watchSessionUsageCommits',
]);

export interface DeferredTuiRuntimeOptions {
  /** Fallback used until the underlying Runtime resolves (for example ACP `initialize`). */
  readonly isGoalEnabled?: () => boolean;
}

/** Lets the product shell or ACP stdio handshake start while calls wait for the Runtime. */
export function createDeferredTuiRuntime<TRuntime extends object = TuiRuntime>(
  runtimePromise: Promise<TRuntime>,
  options: DeferredTuiRuntimeOptions = {},
): TRuntime {
  let resolvedRuntime: TRuntime | undefined;
  void runtimePromise.then(
    (runtime) => {
      resolvedRuntime = runtime;
    },
    () => undefined,
  );

  return new Proxy({} as TRuntime, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === 'newSessionId') {
        return () => {
          if (resolvedRuntime) {
            const fn = Reflect.get(resolvedRuntime, 'newSessionId') as (() => string) | undefined;
            if (typeof fn === 'function') return fn.call(resolvedRuntime);
          }
          return `mvs_${randomUUID().replace(/-/g, '')}`;
        };
      }
      if (property === 'isGoalEnabled') {
        return () => {
          if (resolvedRuntime) {
            const fn = Reflect.get(resolvedRuntime, 'isGoalEnabled') as (() => boolean) | undefined;
            return typeof fn === 'function' ? fn.call(resolvedRuntime) : false;
          }
          return options.isGoalEnabled?.() ?? false;
        };
      }
      // Synchronous like `isGoalEnabled`: no Goal Turn runs before the Runtime exists.
      if (property === 'runningGoalTurnId') {
        return (sessionId: string) => {
          if (!resolvedRuntime) return undefined;
          const fn = Reflect.get(resolvedRuntime, 'runningGoalTurnId') as
            | ((id: string) => string | undefined)
            | undefined;
          return typeof fn === 'function' ? fn.call(resolvedRuntime, sessionId) : undefined;
        };
      }
      if (typeof property !== 'string') return undefined;
      if (ASYNC_GENERATOR_METHODS.has(property)) {
        return (...args: unknown[]) => forwardAsyncGenerator(runtimePromise, property, args);
      }
      return async (...args: unknown[]) => {
        const runtime = await runtimePromise;
        const member = Reflect.get(runtime, property) as unknown;
        if (typeof member !== 'function') return member;
        return Reflect.apply(member, runtime, args) as unknown;
      };
    },
  });
}

async function* forwardAsyncGenerator(
  runtimePromise: Promise<object>,
  property: string,
  args: unknown[],
): AsyncGenerator<unknown> {
  const runtime = await runtimePromise;
  const member = Reflect.get(runtime, property) as unknown;
  if (typeof member !== 'function') return;
  const stream = Reflect.apply(member, runtime, args) as AsyncGenerator<unknown>;
  yield* stream;
}
