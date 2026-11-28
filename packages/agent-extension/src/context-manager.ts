/**
 * `contextManagerExtension`: Installs `ContextManager` through the `@mavis/agent-runtime` extension
 * SPI, letting hosts mount it with `createAgentRuntime({ base: [contextManagerExtension(mgr)] })`
 * instead of manually assigning `hooks.beforeLlmCallHook = [manager.beforeLlmCall]`.
 *
 * The design document §4.3 table identifies context-manager as the first extension to migrate. The
 * SPI uses `pi.on('before_llm_call')` to install `manager.beforeLlmCall`, which returns
 * `PiBeforeLlmCallHookDecision`: `replaceMessages` maps directly to compaction replacement, while
 * `continue`/`skip` mean no compaction is needed.
 *
 * The extension is a stateless factory: the host constructs and passes in `ContextManager`. It
 * performs no IO, creates no locks, and reads no settings, preserving the §4.4 FAQ Q6 boundary that
 * authors isolate extension state with `Map<sessionId, ...>`.
 */

import type {
  AgentExtension,
  ExtensionAPI,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
  PiHistoryChangedHookInput,
} from '@mavis/agent-runtime';
import type { ContextManager } from '@mavis/context-manager';

/**
 * Optional side-effect observer for the extension. Host compaction ownership can wrap
 * `beforeLlmCallHook` with bus-broadcast side effects (`session.compaction.started` / `completed` /
 * `failed`) without adding another host wrapper layer.
 *
 * `onDecision` runs after the manager decision resolves. Its broadcast / metrics side effects are
 * isolated on failure and cannot block a successful manager decision. `onError` runs only when the
 * manager throws; reporter errors are swallowed while the original manager exception propagates to
 * the pi loop.
 * `onHistoryChanged` covers the `pi.on('on_history_changed')` subscription required for
 * context-manager by the design document §4.3 table, for example to persist replacement history
 * through the compaction owner. Observer errors propagate to `PiTurnRunner` after optional
 * reporting. The runner decides by reason whether to warn/continue for `messageDelta` or use
 * `failClosed: true` for `replaceMessages`; the adapter preserves this distinction.
 */
export interface ContextManagerExtensionObserver {
  onDecision?(
    decision: PiBeforeLlmCallHookDecision,
    input: PiBeforeLlmCallHookInput,
  ): void | Promise<void>;
  onError?(error: unknown, input: PiBeforeLlmCallHookInput): void | Promise<void>;
  onHistoryChanged?(input: PiHistoryChangedHookInput): void | Promise<void>;
  /**
   * Optional reporter invoked when `onHistoryChanged` throws. Host decides
   * logging / metrics policy. Reporter errors are swallowed only so they do not
   * shadow the original observer error, which is rethrown to `PiTurnRunner`.
   */
  onHistoryChangedError?(error: unknown, input: PiHistoryChangedHookInput): void | Promise<void>;
}

export interface ContextManagerExtensionOptions {
  readonly manager: ContextManager;
  /** Extension id override; default `'context-manager'` per design doc §4.3. */
  readonly id?: string;
  readonly description?: string;
  /** Side-effect observer for bus broadcasts / metrics; see `ContextManagerExtensionObserver`. */
  readonly observer?: ContextManagerExtensionObserver;
}

/**
 * Build the extension. The factory closes over `manager` so downstream code
 * can call `pi.on(...)` with a stable handler reference in `init`.
 */
export function contextManagerExtension(options: ContextManagerExtensionOptions): AgentExtension {
  const { manager, observer } = options;
  const id = options.id ?? 'context-manager';
  const description =
    options.description ??
    'Compact conversation history before each LLM call to keep the context window under threshold.';
  return {
    id,
    description,
    init(pi: ExtensionAPI): void {
      // `manager.beforeLlmCall` is bound to the manager instance and satisfies
      // the pi-native `PiBeforeLlmCallHook` shape (input) => decision. The SPI
      // adapter re-signs it to (event, ctx) — we drop ctx here since the
      // manager only needs the pi payload it already accepts. Arity is 1 so a
      // future `(...a) => manager.beforeLlmCall(...a)` regression would show up
      // in `context-manager.test.ts` (see arity assertion there).
      pi.on('before_llm_call', async (input) => {
        let decision: PiBeforeLlmCallHookDecision | undefined;
        try {
          decision = await manager.beforeLlmCall(input);
        } catch (err) {
          if (observer?.onError) {
            try {
              await observer.onError(err, input);
            } catch {
              // Observer errors must not shadow the original manager error —
              // swallow so pi loop still sees the manager failure.
            }
          }
          throw err;
        }

        if (observer?.onDecision && decision !== undefined) {
          try {
            await observer.onDecision(decision, input);
          } catch {
            // Decision observers are optional bus / metrics side effects. A
            // reporting failure must not replace a successful manager result.
          }
        }
        return decision;
      });

      if (observer?.onHistoryChanged) {
        const handler = observer.onHistoryChanged;
        const errorSink = observer.onHistoryChangedError;
        pi.on('on_history_changed', async (input) => {
          try {
            await handler(input);
          } catch (err) {
            if (errorSink) {
              try {
                await errorSink(err, input);
              } catch {
                // Reporter failure must not shadow the original persistence error.
              }
            }
            // Preserve the original error so PiTurnRunner can apply its
            // reason-specific policy: messageDelta warns/continues, while
            // replaceMessages is fail-closed.
            throw err;
          }
        });
      }
    },
  };
}
