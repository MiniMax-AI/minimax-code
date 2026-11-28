/**
 * `permissionExtension`: Installs the permission `PermissionEngine` through the
 * `@mavis/agent-runtime` extension SPI's `pi.on('before_tool_call')` short-circuit event (design
 * document §4.3).
 *
 * Boundary policy: `@mavis/permission` is a pure decision engine. `checkPermission(toolName, input,
 * ctx) => PermissionDecision` requires a host-provided `ToolPermissionContext` (including
 * host-specific rules / mode / sandbox state). This factory therefore accepts a host closure
 * `decide(toolName, input, toolCallCtx) => Promise<PermissionDecision>`. The extension only adapts
 * pi context to decision arguments and converts results. The host owns the engine's location:
 * local-runtime uses `LocalPermissionFacade`, cloud-runtime uses `CloudPermissionFacade`; the §4.3
 * table explicitly gives cloud a separate `cloud-permission` extension.
 *
 * Decision mapping (pi's `BeforeToolCallResult` only exposes `{ block?, reason? }`):
 * - `allow`: Write `rewrittenInput` back to live `toolContext.args`, then return `undefined` to
 *   allow execution.
 * - `deny`: Return `{ block: true, reason }`. The host's `reason-format` generates reason for
 *   UI/log consumption; without `formatReason`, fall back to raw JSON.stringify.
 * - `ask`: Default to `{ block: true, reason }`; the pi loop has no native ASK concept, so the
 *   runtime blocks. **If the host provides `onAsk` and it returns a resolved `PermissionDecision`**
 *   (the user actually approved/denied), map that decision instead (allow → undefined; deny/ask →
 *   block). This seam lets the host implement ask fan-out as a blocking promise (UI prompt → user
 *   click → resolve), applying the user's answer to this tool call. **If the host omits `onAsk` or
 *   it returns `void`**, pi immediately sees a block and the LLM receives a denial. The UI must
 *   dispatch ask through a separate event stream (e.g. an HTTP `/permissions` route returns
 *   requestId and the LLM retries in a later turn). This is the current behavior of
 *   `LocalPermissionFacade`.
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
   * - **fire-and-forget**: `onAsk` returns `void | Promise<void>`. The original ask is treated as
   *   `block` and pi sees the tool call denied. Host must fan out the UI prompt on its own channel
   *   and the LLM will retry the call in a subsequent turn.
   * - **await-resolve**: `onAsk` returns `Promise<PermissionDecision>`. The extension awaits it and
   *   re-maps the resolved decision (allow → let the tool call through, deny / ask → block). This
   *   lets a host wrap ask as a blocking UI prompt when the pi loop can tolerate the wait.
   *
   * The third argument is the pi turn's `AbortSignal`; blocking UI prompts should cancel their wait
   * when the turn aborts. `onAsk` errors are swallowed (block posture preserved); pass `onAskError`
   * to observe failures explicitly.
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
