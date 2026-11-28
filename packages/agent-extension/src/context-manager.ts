/**
 * `contextManagerExtension` —— 把 `ContextManager` 装进 `@mavis/agent-runtime`
 * 的 extension SPI，让 host 通过 `createAgentRuntime({ base: [contextManagerExtension(mgr)] })`
 * 挂载而不是自己去 `hooks.beforeLlmCallHook = [manager.beforeLlmCall]`。
 *
 * 设计文档 §4.3 表把 context-manager 定为首个迁移 extension，SPI 侧走
 * `pi.on('before_llm_call')` 装 `manager.beforeLlmCall`（其内部返回
 * `PiBeforeLlmCallHookDecision`——`replaceMessages` 直接对应 compaction
 * 替换，`continue`/`skip` 对应无需压缩）。
 *
 * Extension 是无状态 factory：host 自己构造好 `ContextManager` 实例后传进来。
 * Extension 内部不做 IO、不构造 lock、不读 settings——保持 §4.4 常见问题 Q6
 * "extension 内部状态由作者用 `Map<sessionId, ...>` 隔离" 的边界。
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
 * Optional side-effect observer for the extension. Host compaction ownership can
 * wrap `beforeLlmCallHook` with bus-broadcast side effects (`session.compaction.started`
 * / `completed` / `failed`) without adding another host wrapper layer.
 *
 * `onDecision` 在 manager 决策 resolve 后调用；它只是广播 / metrics 副作用，失败会
 * 被隔离，不能阻断已经成功的 manager 决策。`onError` 只在 manager throw 时调用；
 * reporter 自己的错误会被吞掉，manager 原始异常仍然 propagate 到 pi loop。
 * `onHistoryChanged` covers 设计文档 §4.3 表里 context-manager 需要同时订阅的
 * `pi.on('on_history_changed')` 事件，例如由 compaction owner 持久化 replacement history。
 * observer 抛错会在可选 reporting
 * 后继续向 `PiTurnRunner` 传播；runner 自己按 reason 决定 `messageDelta` warn/continue
 * 或 `replaceMessages` 的 `failClosed: true`，adapter 不抹平这一区别。
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
