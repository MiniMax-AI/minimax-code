/**
 * `permissionExtension` —— 把 permission `PermissionEngine` 装进
 * `@mavis/agent-runtime` 的 extension SPI 的 `pi.on('before_tool_call')`
 * short-circuit event（设计文档 §4.3）。
 *
 * 边界策略：`@mavis/permission` 是纯 decision engine，`checkPermission(toolName,
 * input, ctx) => PermissionDecision` 需要 host 提供 `ToolPermissionContext`
 * （含 rules / mode / sandbox 状态等 host-specific 数据）。因此本 factory 接收
 * host 传入的 `decide(toolName, input, toolCallCtx) => Promise<PermissionDecision>`
 * closure——extension 内部只做"pi ctx → 决策 args → 结果转换"的胶水，engine
 * 本身住哪里由 host 决定（local-runtime 用 `LocalPermissionFacade`，cloud-runtime
 * 用 `CloudPermissionFacade`——设计文档 §4.3 表明确表示 cloud 有独立
 * `cloud-permission` extension）。
 *
 * 决策映射（pi 层 `BeforeToolCallResult` 只有 `{ block?, reason? }` 两态）：
 *   - `allow` → 先将 `rewrittenInput` 写回 live `toolContext.args`，再 return
 *     `undefined`（放行）
 *   - `deny`  → `{ block: true, reason }`（reason 由 host 侧 `reason-format`
 *     生成，UI/日志侧读；若未提供 `formatReason` 用 raw JSON.stringify 做兜底）
 *   - `ask`   → default `{ block: true, reason }`——pi loop 无原生 ASK 概念，
 *     运行时按 block 处理。**若 host 提供 `onAsk` 且它返回一个 resolved
 *     `PermissionDecision`**（用户实际同意/拒绝了），extension 会以 resolved
 *     决策的映射结果为准（allow → undefined 放行，deny/ask → block）。这条 seam
 *     让 host 能够把 ask fan-out 做成阻塞 promise（UI prompt → user click →
 *     resolve），本轮工具调用可以按用户回复实际放行/拒绝。**若 host 不提供 `onAsk`
 *     或它返回 `void`**，pi loop 直接看到 block，LLM 会收到拒绝，UI 需通过独立
 *     event 流分派 ask（比如 HTTP `/permissions` route 返回 requestId、
 *     LLM 需要在后续 turn 里重试），这是当前 host（`LocalPermissionFacade`）的
 *     现状。
 *
 */

import type { AgentExtension, BeforeToolCallHandler, ExtensionAPI } from '@mavis/agent-runtime';
import type { PermissionDecision } from '@mavis/permission';

/** Minimal shape captured from pi `BeforeToolCallContext` — subset actually needed by decision engines. */
export interface PermissionToolCallSummary {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type PermissionDecider = (
  summary: PermissionToolCallSummary,
) => PermissionDecision | Promise<PermissionDecision>;

export interface PermissionExtensionOptions {
  readonly decide: PermissionDecider;
  /** Extension id override; default `'permission'` per design doc §4.3. */
  readonly id?: string;
  readonly description?: string;
  /**
   * Convert `PermissionDecision.reason` to a human-readable string embedded in
   * the pi `BeforeToolCallResult.reason` field. Defaults to `JSON.stringify`
   * on the reason object—hosts wanting the localized `reason-format` output
   * pass their own formatter here (e.g. `formatDecisionReason` from
   * `@mavis/permission`).
   *
   * Caveat: default JSON.stringify drops `Map` values (e.g. `subcommandResults`
   * in bash-decision reason variants) — host formatters should handle those
   * variants explicitly. Path values inside reason are not scrubbed here;
   * host formatters can redact if needed before logging.
   */
  readonly formatReason?: (
    decision: PermissionDecision,
    summary: PermissionToolCallSummary,
  ) => string;
  /**
   * Optional side-effect / resume seam for `ask` decisions. Two modes:
   *
   *   - **fire-and-forget**: `onAsk` returns `void | Promise<void>`. The
   *     original ask is treated as `block` and pi sees the tool call denied.
   *     Host must fan out the UI prompt on its own channel and the LLM will
   *     retry the call in a subsequent turn.
   *
   *   - **await-resolve**: `onAsk` returns `Promise<PermissionDecision>`. The
   *     extension awaits it and re-maps the resolved decision (allow → let
   *     the tool call through, deny / ask → block). This lets a host wrap ask
   *     as a blocking UI prompt when the pi loop can tolerate the wait.
   *
   * 第三个参数是 pi turn 的 `AbortSignal`，blocking UI prompt 应在 turn
   * abort 时取消等待。`onAsk` errors are swallowed (block posture preserved);
   * pass `onAskError` to observe failures explicitly.
   */
  readonly onAsk?: (
    decision: PermissionDecision,
    summary: PermissionToolCallSummary,
    signal?: AbortSignal,
  ) => void | Promise<void | PermissionDecision | undefined>;
  /** Optional sink for `onAsk` failures — visibility on UI fan-out breakage. */
  readonly onAskError?: (
    error: unknown,
    summary: PermissionToolCallSummary,
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

function defaultFormatReason(decision: PermissionDecision): string {
  try {
    return JSON.stringify(decision.reason);
  } catch {
    return String(decision.reason);
  }
}

function applyRewrittenInput(
  toolContext: Parameters<BeforeToolCallHandler>[0],
  rewrittenInput: Record<string, unknown> | undefined,
): void {
  if (!rewrittenInput) return;
  if (
    toolContext.args &&
    typeof toolContext.args === 'object' &&
    !Array.isArray(toolContext.args)
  ) {
    const target = toolContext.args as Record<string, unknown>;
    if (target === rewrittenInput) return;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, rewrittenInput);
    return;
  }
  toolContext.args = { ...rewrittenInput };
}

export function permissionExtension(options: PermissionExtensionOptions): AgentExtension {
  const { decide, formatReason = defaultFormatReason, onAsk, onAskError } = options;
  const id = options.id ?? 'permission';
  const description =
    options.description ??
    'Enforce tool-call permission decisions (allow / deny / ask) via PermissionEngine before pi executes each tool.';

  function mapDecision(
    decision: PermissionDecision,
    summary: PermissionToolCallSummary,
    toolContext: Parameters<BeforeToolCallHandler>[0],
    fallbackRewrittenInput?: Record<string, unknown>,
  ): { block: true; reason: string } | undefined {
    if (decision.behavior === 'allow') {
      applyRewrittenInput(toolContext, decision.rewrittenInput ?? fallbackRewrittenInput);
      return undefined;
    }
    // deny / ask / any future variant → fail-closed block per AGENTS.md §5.
    // The default branch defends against `PermissionBehavior` growing new
    // variants without a matching mapDecision arm; today it's unreachable
    // (union is `'allow' | 'deny' | 'ask'`), which is exactly the invariant
    // this comment records.
    return { block: true, reason: formatReason(decision, summary) };
  }

  const handler: BeforeToolCallHandler = async (toolContext, signal) => {
    const summary: PermissionToolCallSummary = {
      toolName: toolContext.toolCall.name,
      input: (toolContext.args ?? {}) as Readonly<Record<string, unknown>>,
    };
    const decision = await decide(summary);
    if (decision.behavior === 'ask' && onAsk) {
      let resolved: PermissionDecision | undefined;
      try {
        const askResult = await onAsk(decision, summary, signal);
        if (askResult && typeof askResult === 'object' && 'behavior' in askResult) {
          resolved = askResult as PermissionDecision;
        }
      } catch (err) {
        if (onAskError) {
          try {
            await onAskError(err, summary, signal);
          } catch {
            // Observer error must not shadow the block posture.
          }
        }
      }
      const effective = resolved ?? decision;
      return mapDecision(effective, summary, toolContext, decision.rewrittenInput);
    }
    return mapDecision(decision, summary, toolContext);
  };

  return {
    id,
    description,
    init(pi: ExtensionAPI): void {
      pi.on('before_tool_call', handler);
    },
  };
}
