import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import type {
  PluginHookCommandHandler,
  PluginHookDecision,
  PluginHookEventInput,
  PluginHookLogger,
  PluginHookObserver,
  PluginHookPermissionUpdate,
  PluginHookPermissionUpdateDestination,
  PluginHookPermissionUpdateMode,
  PluginHookPermissionRuleValue,
  PluginHookRunDiagnostic,
  PluginHookRunResult,
} from './contracts.js';
import { resolveHookCommandInvocation } from './command-invocation.js';
import { isSafePluginHookMatcher } from './parser.js';
import { boundHandlerDecision } from './output-artifacts.js';
import {
  adaptToolIdentity,
  hasOnlyKeys,
  hasCompatibleJsonShape,
  isMcpToolInput,
  resolveHookFilePath,
  restoreNativeToolInput,
} from './wire-tool-adapter.js';

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_REASON_CHARS = 4_096;
const MAX_INJECTED_TEXT_CHARS = 64 * 1024;
const MAX_OUTPUT_VALUE_DEPTH = 64;
const MAX_OUTPUT_VALUE_NODES = 10_000;
const ORDINARY_EVENT_BUDGET_MS = 15_000;
const SESSION_END_BUDGET_MS = 3_000;
const PROCESS_DRAIN_BUDGET_MS = 500;

export class PluginHookRunner {
  private logger?: PluginHookLogger;
  private observer?: PluginHookObserver;
  private readonly activeChildren = new Set<ChildProcess>();
  private readonly disposalController = new AbortController();
  private disposed = false;

  constructor(logger?: PluginHookLogger, observer?: PluginHookObserver) {
    this.logger = logger;
    this.observer = observer;
  }

  configure(input: {
    readonly logger?: PluginHookLogger;
    readonly observer?: PluginHookObserver;
  }): void {
    this.logger = input.logger;
    this.observer = input.observer;
  }

  async run(
    handlers: readonly PluginHookCommandHandler[],
    input: PluginHookEventInput,
    signal?: AbortSignal,
  ): Promise<PluginHookRunResult> {
    const eventStartedAt = Date.now();
    const unavailableAdapters = handlers.filter(
      (handler) =>
        needsPostToolAdapter(handler, input) &&
        matches(handler, withPostToolAdapterEvidence(handler, input)) &&
        matchesCondition(handler, withPostToolAdapterEvidence(handler, input)),
    );
    const unavailable = new Set(unavailableAdapters);
    const selected = handlers
      .filter(
        (handler) =>
          !unavailable.has(handler) &&
          handler.event === input.event &&
          isEventSupportedBySource(handler, input) &&
          matches(handler, input) &&
          matchesCondition(handler, input),
      )
      .sort(compareHandlers);
    const eventBudgetMs =
      input.event === 'SessionEnd' ? SESSION_END_BUDGET_MS : ORDINARY_EVENT_BUDGET_MS;
    const diagnostics: PluginHookRunDiagnostic[] = unavailableAdapters.map((handler) =>
      runDiagnostic(handler, 'HOOK_INVALID_INPUT'),
    );
    for (const [index, diagnostic] of diagnostics.entries()) {
      const handler = unavailableAdapters[index];
      if (!handler) continue;
      this.logger?.warn(
        { ...diagnostic },
        'Plugin hook command skipped because its vendor tool response could not be adapted losslessly',
      );
      observeHandler(this.observer, {
        event: input.event,
        format: handler.sourceFormat,
        outcome: 'error',
        durationMs: 0,
        processKilled: false,
      });
    }
    let completionCounter = 0;
    const outcomes = await mapWithConcurrency(
      selected,
      MAX_CONCURRENT_COMMANDS,
      async (handler) => {
        const handlerStartedAt = Date.now();
        const remainingEventBudgetMs = eventStartedAt + eventBudgetMs - handlerStartedAt;
        const outcome =
          remainingEventBudgetMs <= 0
            ? {
                diagnostic: runDiagnostic(handler, 'HOOK_TIMEOUT' as const),
                processKilled: false,
              }
            : await this.runCommand(
                handler,
                input,
                Math.min(handler.timeoutMs, remainingEventBudgetMs),
                signal,
              );
        const completionOrder = completionCounter;
        completionCounter += 1;
        if (outcome.diagnostic) {
          this.logger?.warn({ ...outcome.diagnostic }, 'Plugin hook command failed open');
          observeHandler(this.observer, {
            event: input.event,
            format: handler.sourceFormat,
            outcome: diagnosticOutcome(outcome.diagnostic.code),
            durationMs: Date.now() - handlerStartedAt,
            processKilled: outcome.processKilled,
          });
        } else if (outcome.decision) {
          observeHandler(this.observer, {
            event: input.event,
            format: handler.sourceFormat,
            outcome:
              outcome.decision.decision === 'deny'
                ? 'deny'
                : outcome.decision.decision === 'ask' || outcome.decision.decision === 'defer'
                  ? 'ask'
                  : 'success',
            durationMs: Date.now() - handlerStartedAt,
            processKilled: outcome.processKilled,
          });
        }
        return { ...outcome, handler, completionOrder };
      },
    );
    let decision = defaultDecision(input.event);
    let firstCodexWinningReason: string | undefined;
    let firstCodexStopReason: string | undefined;
    for (const outcome of outcomes) {
      if (outcome.diagnostic) diagnostics.push(outcome.diagnostic);
      if (outcome.decision) {
        if (
          outcome.handler.sourceFormat === 'CODEX' &&
          firstCodexWinningReason === undefined &&
          isCodexWinningReason(input.event, outcome.decision)
        ) {
          firstCodexWinningReason = outcome.decision.reason;
        }
        if (
          outcome.handler.sourceFormat === 'CODEX' &&
          firstCodexStopReason === undefined &&
          outcome.decision.continue === false
        ) {
          firstCodexStopReason = outcome.decision.stopReason;
        }
        decision = mergePluginHookDecisions(decision, outcome.decision);
      }
    }
    if (firstCodexWinningReason !== undefined) {
      decision = { ...decision, reason: firstCodexWinningReason };
    }
    if (firstCodexStopReason !== undefined) {
      decision = { ...decision, stopReason: firstCodexStopReason };
    }
    if (input.event === 'PreToolUse' && decision.decision !== 'deny') {
      const latestCompatibleRewrite = outcomes
        .filter(
          (outcome) =>
            outcome.handler.sourceFormat !== 'MINIMAX' &&
            outcome.decision?.updatedInput !== undefined,
        )
        .sort((left, right) => right.completionOrder - left.completionOrder)[0]
        ?.decision?.updatedInput;
      if (latestCompatibleRewrite !== undefined) {
        decision = { ...decision, updatedInput: latestCompatibleRewrite };
      }
    }
    if (input.event === 'PreToolUse' && decision.decision === 'deny' && decision.updatedInput) {
      const blockedDecision = { ...decision };
      delete blockedDecision.updatedInput;
      decision = blockedDecision;
    }
    observeEvent(this.observer, {
      event: input.event,
      outcome: eventOutcome(decision, diagnostics),
      durationMs: Date.now() - eventStartedAt,
    });
    return { decision, diagnostics };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalController.abort('Plugin Hook runner disposed');
    await Promise.allSettled([...this.activeChildren].map((child) => terminateAndDrain(child)));
  }

  private async runCommand(
    handler: PluginHookCommandHandler,
    input: PluginHookEventInput,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{
    decision?: PluginHookDecision;
    diagnostic?: PluginHookRunDiagnostic;
    processKilled: boolean;
  }> {
    if (signal?.aborted || this.disposalController.signal.aborted) {
      return { diagnostic: runDiagnostic(handler, 'HOOK_ABORTED'), processKilled: false };
    }
    const handlerInput = adaptVendorInput(handler, input);
    if (!isValidWireInput(handler, handlerInput)) {
      return { diagnostic: runDiagnostic(handler, 'HOOK_INVALID_INPUT'), processKilled: false };
    }
    const serialized = serializeHookInput(handlerInput);
    if (!serialized) {
      return { diagnostic: runDiagnostic(handler, 'HOOK_INVALID_INPUT'), processKilled: false };
    }
    let child: ChildProcess;
    const pluginDataDir =
      handler.pluginDataDir ?? resolvePluginDataDirectory(handler.pluginRoot, handler.pluginName);
    try {
      await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });
      const env = {
        ...safeHookEnvironment(),
        MINIMAX_PLUGIN_ROOT: handler.pluginRoot,
        CLAUDE_PLUGIN_ROOT: handler.pluginRoot,
        CODEX_PLUGIN_ROOT: handler.pluginRoot,
        PLUGIN_ROOT: handler.pluginRoot,
        CLAUDE_PLUGIN_DATA: pluginDataDir,
        PLUGIN_DATA: pluginDataDir,
        MINIMAX_PROJECT_DIR: input.cwd,
        CLAUDE_PROJECT_DIR: input.cwd,
        CODEX_PROJECT_DIR: input.cwd,
        ...(handler.sourceFormat === 'CLAUDE' && handlerInput.effort
          ? { CLAUDE_EFFORT: handlerInput.effort.level }
          : {}),
      };
      const command = expandHookPlaceholders(handler.command, env);
      const args = handler.args?.map((value) => expandHookPlaceholders(value, env));
      const invocation = resolveHookCommandInvocation({
        command,
        ...(args ? { args } : {}),
        ...(handler.shell ? { shell: handler.shell } : {}),
        sourceFormat: handler.sourceFormat,
      });
      child = spawn(invocation.command, invocation.args, {
        cwd: input.cwd,
        env,
        shell: invocation.shell,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return { diagnostic: runDiagnostic(handler, 'HOOK_PROCESS_ERROR'), processKilled: false };
    }
    this.activeChildren.add(child);
    const overflowController = new AbortController();
    const readOutput = collectOutput(child, () => overflowController.abort());
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(serialized);
    try {
      const result = await waitForChild(
        child,
        timeoutMs,
        [...(signal ? [signal] : []), this.disposalController.signal],
        overflowController.signal,
      );
      const captured = readOutput();
      if (result.reason === 'aborted') {
        return { diagnostic: runDiagnostic(handler, 'HOOK_ABORTED'), processKilled: result.killed };
      }
      if (result.reason === 'timeout') {
        return { diagnostic: runDiagnostic(handler, 'HOOK_TIMEOUT'), processKilled: result.killed };
      }
      if (result.reason === 'overflow' || captured.overflow) {
        return {
          diagnostic: runDiagnostic(handler, 'HOOK_INVALID_OUTPUT'),
          processKilled: result.killed,
        };
      }
      if (result.reason !== 'exit') {
        return { diagnostic: runDiagnostic(handler, 'HOOK_PROCESS_ERROR'), processKilled: true };
      }
      const killedDescendants = await terminateRemainingProcessGroup(child);
      // Codex only interprets structured stdout from a successful command.
      // Compatible intentionally parses JSON on every exit code; exit 2 then adds
      // the event-specific blocking effect which JSON cannot override.
      const parsesStdout =
        !(handler.sourceFormat === 'CODEX' && input.event === 'SessionEnd') &&
        (handler.sourceFormat !== 'CODEX' || result.code === 0);
      const parsed = parsesStdout
        ? parseDecision(captured.stdout, handler, input)
        : ({ kind: 'empty', decision: defaultDecision(input.event) } as const);
      const exitDecision =
        result.code === 2 && handler.sourceFormat !== 'MINIMAX'
          ? explicitExitTwoDecision(input.event, captured.stderr, handler.sourceFormat)
          : undefined;
      if (parsed.kind === 'invalid') {
        if (exitDecision) {
          return {
            decision: await boundHandlerDecision(handler, input, exitDecision),
            processKilled: killedDescendants,
          };
        }
        return {
          ...(parsed.decision
            ? { decision: await boundHandlerDecision(handler, input, parsed.decision) }
            : {}),
          diagnostic: runDiagnostic(handler, 'HOOK_INVALID_OUTPUT'),
          processKilled: killedDescendants,
        };
      }
      if (parsed.kind === 'structured') {
        const decision = exitDecision
          ? mergeExitTwoDecision(
              parsed.decision,
              exitDecision,
              input.event,
              handler.sourceFormat,
              parsed.hasStructuredBlock,
            )
          : parsed.decision;
        return {
          decision: await boundHandlerDecision(handler, input, decision),
          processKilled: killedDescendants,
        };
      }
      if (exitDecision)
        return {
          decision: await boundHandlerDecision(handler, input, exitDecision),
          processKilled: killedDescendants,
        };
      if (result.code !== 0) {
        return {
          diagnostic: runDiagnostic(handler, 'HOOK_PROCESS_EXITED'),
          processKilled: killedDescendants,
        };
      }
      return {
        decision: await boundHandlerDecision(handler, input, parsed.decision),
        processKilled: killedDescendants,
      };
    } finally {
      this.activeChildren.delete(child);
    }
  }
}

/** Per-Plugin writable directory shared by Hooks and Plugin Agent prompts. */
export function resolvePluginDataDirectory(pluginRoot: string, pluginName: string): string {
  return resolvePath(pluginRoot, '..', '.plugin-data', safePluginDataName(pluginName));
}

function safePluginDataName(pluginName: string): string {
  const safe = pluginName.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80);
  return safe || 'plugin';
}

function diagnosticOutcome(code: PluginHookRunDiagnostic['code']): 'error' | 'timeout' | 'aborted' {
  if (code === 'HOOK_TIMEOUT') return 'timeout';
  if (code === 'HOOK_ABORTED') return 'aborted';
  return 'error';
}

function eventOutcome(
  decision: PluginHookDecision,
  diagnostics: readonly PluginHookRunDiagnostic[],
): 'success' | 'deny' | 'ask' | 'degraded' | 'timeout' | 'aborted' {
  if (decision.decision === 'deny') return 'deny';
  if (decision.decision === 'ask' || decision.decision === 'defer') return 'ask';
  if (diagnostics.some((item) => item.code === 'HOOK_ABORTED')) return 'aborted';
  if (diagnostics.some((item) => item.code === 'HOOK_TIMEOUT')) return 'timeout';
  return diagnostics.length > 0 ? 'degraded' : 'success';
}

function observeHandler(
  observer: PluginHookObserver | undefined,
  input: Parameters<PluginHookObserver['onHandler']>[0],
): void {
  try {
    observer?.onHandler(input);
  } catch {
    // Observability is best-effort and must never change Hook behavior.
  }
}

function observeEvent(
  observer: PluginHookObserver | undefined,
  input: Parameters<PluginHookObserver['onEvent']>[0],
): void {
  try {
    observer?.onEvent(input);
  } catch {
    // Observability is best-effort and must never change Hook behavior.
  }
}

function collectOutput(
  child: ChildProcess,
  onOverflow: () => void,
): () => { stdout: string; stderr: string; overflow: boolean } {
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let overflow = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > MAX_OUTPUT_BYTES && !overflow) {
      overflow = true;
      onOverflow();
    }
    stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX_OUTPUT_BYTES);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length + chunk.length > MAX_OUTPUT_BYTES && !overflow) {
      overflow = true;
      onOverflow();
    }
    stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_OUTPUT_BYTES);
  });
  return () => ({
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    overflow,
  });
}

function waitForChild(
  child: ChildProcess,
  timeoutMs: number,
  signals: readonly AbortSignal[],
  overflowSignal: AbortSignal,
): Promise<
  | { readonly reason: 'exit'; readonly code: number; readonly killed: false }
  | { readonly reason: 'aborted' | 'timeout' | 'overflow'; readonly killed: true }
> {
  return new Promise((resolve) => {
    let settled = false;
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      value:
        | { readonly reason: 'exit'; readonly code: number; readonly killed: false }
        | { readonly reason: 'aborted' | 'timeout' | 'overflow'; readonly killed: true },
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', abort);
      overflowSignal.removeEventListener('abort', overflow);
      resolve(value);
    };
    const stop = async (reason: 'aborted' | 'timeout' | 'overflow') => {
      if (stopping || settled) return;
      stopping = true;
      await terminateAndDrain(child);
      finish({ reason, killed: true });
    };
    const abort = () => void stop('aborted');
    const overflow = () => void stop('overflow');
    timer = setTimeout(() => void stop('timeout'), timeoutMs);
    child.once('error', () => finish({ reason: 'exit', code: 1, killed: false }));
    child.once('close', (code) => {
      if (!stopping) finish({ reason: 'exit', code: code ?? 1, killed: false });
    });
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    overflowSignal.addEventListener('abort', overflow, { once: true });
    if (signals.some((signal) => signal.aborted)) abort();
    else if (overflowSignal.aborted) overflow();
  });
}

async function terminateAndDrain(child: ChildProcess): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });
  try {
    if (process.platform === 'win32' && child.pid) {
      const killed = await waitBounded(runTaskkill(child.pid), PROCESS_DRAIN_BUDGET_MS, false);
      if (!killed) child.kill('SIGKILL');
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already have exited.
    }
  }
  await waitBounded(closed, PROCESS_DRAIN_BUDGET_MS, undefined);
}

async function terminateRemainingProcessGroup(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return false;
  if (process.platform === 'win32') {
    return await waitBounded(runTaskkill(child.pid), PROCESS_DRAIN_BUDGET_MS, false);
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

async function runTaskkill(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => resolve(false));
    killer.once('close', (code) => resolve(code === 0));
  });
}

async function waitBounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ParsedHookOutput =
  | {
      readonly kind: 'structured';
      readonly decision: PluginHookDecision;
      readonly hasStructuredBlock: boolean;
    }
  | { readonly kind: 'plain'; readonly decision: PluginHookDecision }
  | { readonly kind: 'empty'; readonly decision: PluginHookDecision }
  | { readonly kind: 'invalid'; readonly decision?: PluginHookDecision };

function parseDecision(
  stdout: string,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): ParsedHookOutput {
  const event = input.event;
  const sourceFormat = handler.sourceFormat;
  const output = stdout.trim();
  if (!output) return { kind: 'empty', decision: defaultDecision(event) };
  const looksLikeStructuredOutput =
    output.startsWith('{') || (sourceFormat === 'CODEX' && output.startsWith('['));
  if (!looksLikeStructuredOutput) {
    return {
      kind: 'plain',
      decision: supportsPlainTextContext(event, sourceFormat)
        ? { ...defaultDecision(event), additionalContext: output }
        : defaultDecision(event),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    if (sourceFormat !== 'CLAUDE') return { kind: 'invalid' };
    return {
      kind: 'plain',
      decision: supportsPlainTextContext(event, sourceFormat)
        ? { ...defaultDecision(event), additionalContext: output }
        : defaultDecision(event),
    };
  }
  if (!isRecord(value) || !isSafeHookOutputValue(value)) return { kind: 'invalid' };
  const decision = parseWireDecision(value, handler, input);
  if (decision) {
    return {
      kind: 'structured',
      decision,
      hasStructuredBlock: value.decision === 'block' || decision.continue === false,
    };
  }
  const warning = codexUnsupportedControlSystemWarning(value, handler, input);
  return warning ? { kind: 'invalid', decision: warning } : { kind: 'invalid' };
}

function parseWireDecision(
  value: Record<string, unknown>,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): PluginHookDecision | undefined {
  const event = input.event;
  const sourceFormat = handler.sourceFormat;
  const allowed = allowedWireOutputKeys(event, sourceFormat);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const universal = parseUniversalOutput(value, event, sourceFormat);
  if (!universal) return undefined;
  const specificValue = value.hookSpecificOutput;
  if (specificValue !== undefined && !isRecord(specificValue)) return undefined;
  const specific = isRecord(specificValue) ? specificValue : undefined;
  if (specific && specific.hookEventName !== event) return undefined;
  const base: PluginHookDecision = { ...defaultDecision(event), ...universal };
  if (base.continue === false && !(event === 'PostToolUse' && sourceFormat === 'CODEX')) {
    return base;
  }

  if (event === 'PermissionRequest') {
    return parsePermissionRequestOutput(base, specific, handler, input);
  }
  if (event === 'PreToolUse') {
    return parsePreToolUseOutput(base, value, specific, handler, input);
  }

  const additionalContext = readAdditionalContext(specific);
  if (
    specific &&
    event !== 'PostToolUse' &&
    Object.keys(specific).some(
      (key) =>
        key !== 'hookEventName' &&
        key !== 'additionalContext' &&
        !isIgnoredCompatibleHookSpecificOutputKey(sourceFormat, event, key),
    )
  )
    return undefined;
  if (specific?.additionalContext !== undefined && additionalContext === undefined)
    return undefined;
  if (event === 'PostToolUse') {
    return parsePostToolUseOutput(base, value, specific, handler, input, additionalContext);
  }

  const topDecision = value.decision;
  const reason = readReason(value.reason);
  if (value.reason !== undefined && reason === undefined) return undefined;
  if (topDecision !== undefined && topDecision !== 'block') return undefined;
  if (topDecision === 'block' && !reason) return undefined;
  if (topDecision === 'block') {
    if (event === 'UserPromptSubmit') {
      return { ...base, decision: 'deny', reason };
    }
    if (event === 'Stop' || event === 'SubagentStop') {
      return {
        ...base,
        continuePrompt: mergePluginHookContext(reason, additionalContext),
      };
    }
    if (event === 'PreCompact' && sourceFormat !== 'CODEX') {
      return { ...base, defer: true, reason };
    }
    return undefined;
  }
  if (reason !== undefined) return undefined;
  if (additionalContext) {
    if (
      event !== 'SessionStart' &&
      event !== 'SubagentStart' &&
      event !== 'UserPromptSubmit' &&
      event !== 'Stop' &&
      event !== 'SubagentStop'
    )
      return undefined;
    if (event === 'Stop' || event === 'SubagentStop') {
      return { ...base, continuePrompt: additionalContext };
    }
    return { ...base, additionalContext };
  }
  return base;
}

function explicitExitTwoDecision(
  event: PluginHookEventInput['event'],
  stderr: string,
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
): PluginHookDecision | undefined {
  const providedReason = readReason(stderr);
  if (sourceFormat === 'CODEX' && !providedReason) return undefined;
  const reason = providedReason ?? 'Plugin Hook blocked this operation.';
  if (event === 'UserPromptSubmit' || event === 'PreToolUse') {
    return { decision: 'deny', reason };
  }
  if (event === 'PermissionRequest' && sourceFormat === 'CODEX') {
    return { decision: 'deny', permissionDecision: 'deny', reason };
  }
  if (event === 'PostToolUse') {
    return sourceFormat === 'CODEX'
      ? { decision: 'allow', postToolFeedback: reason }
      : { decision: 'allow', additionalContext: reason };
  }
  if (event === 'Stop' || event === 'SubagentStop') {
    return { decision: 'allow', continuePrompt: reason };
  }
  if (event === 'PreCompact' && sourceFormat === 'CLAUDE') {
    return { decision: 'allow', defer: true, reason };
  }
  return undefined;
}

function mergeExitTwoDecision(
  parsed: PluginHookDecision,
  exitDecision: PluginHookDecision,
  event: PluginHookEventInput['event'],
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
  hasStructuredBlock: boolean,
): PluginHookDecision {
  if (event === 'PermissionRequest' && sourceFormat === 'CLAUDE') return parsed;
  if (sourceFormat === 'CLAUDE' && hasStructuredBlock) {
    // Compatible keeps exit-code 2 blocking, but a structured blocking reason wins
    // over stderr. `parsed` already carries the event-specific blocking effect.
    return parsed;
  }
  if (event === 'PostToolUse' && sourceFormat === 'CODEX') {
    const nonStoppingParsed = withoutStoppingControls(parsed);
    return {
      ...nonStoppingParsed,
      postToolFeedback: mergePluginHookContext(
        parsed.postToolFeedback,
        exitDecision.postToolFeedback,
      ),
    };
  }
  return mergePluginHookDecisions(parsed, exitDecision);
}

function parsePermissionRequestOutput(
  base: PluginHookDecision,
  specific: Record<string, unknown> | undefined,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): PluginHookDecision | undefined {
  const sourceFormat = handler.sourceFormat;
  if (!specific) return base;
  if (Object.keys(specific).some((key) => key !== 'hookEventName' && key !== 'decision')) {
    return undefined;
  }
  if (specific.decision === undefined) return base;
  if (!isRecord(specific.decision)) return undefined;
  const decision = specific.decision;
  const allowed = new Set([
    'behavior',
    'updatedInput',
    'updatedPermissions',
    'message',
    'interrupt',
  ]);
  if (Object.keys(decision).some((key) => !allowed.has(key))) return undefined;
  if (decision.behavior !== 'allow' && decision.behavior !== 'deny') return undefined;
  if (decision.message !== undefined && typeof decision.message !== 'string') return undefined;
  if (decision.interrupt !== undefined && typeof decision.interrupt !== 'boolean') return undefined;
  if (decision.updatedInput !== undefined && !isRecord(decision.updatedInput)) return undefined;
  const restoredUpdatedInput = isRecord(decision.updatedInput)
    ? restoreNativeToolInput(decision.updatedInput, handler, input)
    : undefined;
  if (decision.updatedInput !== undefined && restoredUpdatedInput === undefined) return undefined;
  if (decision.updatedPermissions !== undefined && !Array.isArray(decision.updatedPermissions)) {
    return undefined;
  }
  if (
    sourceFormat === 'CODEX' &&
    (decision.updatedInput !== undefined ||
      decision.updatedPermissions !== undefined ||
      decision.interrupt === true)
  )
    return undefined;
  if (sourceFormat === 'MINIMAX' && decision.updatedPermissions !== undefined) return undefined;
  const updatedPermissions =
    sourceFormat === 'CLAUDE' && Array.isArray(decision.updatedPermissions)
      ? parseCompatiblePermissionUpdates(decision.updatedPermissions, handler, input)
      : undefined;
  if (sourceFormat === 'CLAUDE' && decision.updatedPermissions !== undefined && !updatedPermissions)
    return undefined;
  if (decision.behavior === 'allow') {
    if (sourceFormat === 'CLAUDE' && decision.message !== undefined) return undefined;
    if (decision.interrupt === true) return undefined;
    return {
      ...base,
      permissionDecision: 'allow',
      permissionAutoApproval: sourceFormat === 'CODEX' ? 'any_prompt' : 'ordinary_only',
      ...(restoredUpdatedInput ? { updatedInput: restoredUpdatedInput } : {}),
      ...(updatedPermissions?.length ? { updatedPermissions } : {}),
    };
  }
  if (decision.updatedInput !== undefined || decision.updatedPermissions !== undefined) {
    return undefined;
  }
  const reason = readReason(decision.message) ?? 'PermissionRequest Hook denied approval.';
  return {
    ...base,
    decision: 'deny',
    permissionDecision: 'deny',
    reason,
    ...(decision.interrupt === true
      ? { interrupt: true, continue: false, stopReason: reason }
      : {}),
  };
}

function parseCompatiblePermissionUpdates(
  values: readonly unknown[],
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): readonly PluginHookPermissionUpdate[] | undefined {
  const parsed: PluginHookPermissionUpdate[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.type !== 'string') return undefined;
    const destination = readPermissionUpdateDestination(value.destination);
    if (!destination) return undefined;
    if (
      value.type === 'addRules' ||
      value.type === 'replaceRules' ||
      value.type === 'removeRules'
    ) {
      if (!hasOnlyKeys(value, ['type', 'rules', 'behavior', 'destination'])) return undefined;
      if (value.behavior !== 'allow' && value.behavior !== 'deny' && value.behavior !== 'ask') {
        return undefined;
      }
      if (!Array.isArray(value.rules)) return undefined;
      const rules = value.rules.map((rule) => parseCompatiblePermissionRule(rule, handler, input));
      if (rules.some((rule) => rule === undefined)) return undefined;
      parsed.push({
        type: value.type,
        rules: rules as PluginHookPermissionRuleValue[],
        behavior: value.behavior,
        destination,
      });
      continue;
    }
    if (value.type === 'setMode') {
      if (!hasOnlyKeys(value, ['type', 'mode', 'destination'])) return undefined;
      const mode = readPermissionUpdateMode(value.mode);
      if (!mode) return undefined;
      parsed.push({ type: 'setMode', mode, destination });
      continue;
    }
    if (value.type === 'addDirectories' || value.type === 'removeDirectories') {
      if (!hasOnlyKeys(value, ['type', 'directories', 'destination'])) return undefined;
      if (
        !Array.isArray(value.directories) ||
        value.directories.some(
          (directory) =>
            typeof directory !== 'string' ||
            !directory.trim() ||
            directory.includes('\u0000') ||
            directory.length > 16_384,
        )
      ) {
        return undefined;
      }
      parsed.push({
        type: value.type,
        directories: value.directories.map((directory) =>
          resolveHookFilePath(directory.trim(), input.cwd),
        ),
        destination,
      });
      continue;
    }
    return undefined;
  }
  return parsed;
}

function parseCompatiblePermissionRule(
  value: unknown,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): PluginHookPermissionRuleValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['toolName', 'ruleContent'])) return undefined;
  if (typeof value.toolName !== 'string' || !value.toolName.trim()) return undefined;
  if (
    value.ruleContent !== undefined &&
    (typeof value.ruleContent !== 'string' || value.ruleContent.length > 64 * 1024)
  ) {
    return undefined;
  }
  const toolName = restoreNativePermissionRuleToolName(value.toolName.trim(), handler, input);
  return {
    toolName,
    ...(value.ruleContent !== undefined ? { ruleContent: value.ruleContent } : {}),
  };
}

function restoreNativePermissionRuleToolName(
  value: string,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): string {
  if (value === 'Bash' || value === 'PowerShell') return 'bash';
  if (value === 'Read') return 'read';
  if (value === 'Write') return 'write';
  if (value === 'Edit') return 'edit';
  if (value === 'Agent') return 'task';
  const prefix = `mcp__plugin_${handler.pluginName}_`;
  if (value.startsWith(prefix)) return `mcp__${value.slice(prefix.length)}`;
  const currentNativeName =
    typeof input.payload?.tool_name === 'string' ? input.payload.tool_name : input.matcherValue;
  const currentVendorName = adaptToolIdentity(
    handler,
    input.event,
    input.payload ?? {},
    input.matcherValue,
    input.toolProvenance,
    input.cwd,
  ).toolName;
  return value === currentVendorName && currentNativeName ? currentNativeName : value;
}

function readPermissionUpdateDestination(
  value: unknown,
): PluginHookPermissionUpdateDestination | undefined {
  return value === 'session' ||
    value === 'localSettings' ||
    value === 'projectSettings' ||
    value === 'userSettings'
    ? value
    : undefined;
}

function readPermissionUpdateMode(value: unknown): PluginHookPermissionUpdateMode | undefined {
  if (value === 'manual') return 'default';
  return value === 'default' ||
    value === 'auto' ||
    value === 'acceptEdits' ||
    value === 'dontAsk' ||
    value === 'bypassPermissions' ||
    value === 'plan'
    ? value
    : undefined;
}

function parsePreToolUseOutput(
  base: PluginHookDecision,
  value: Record<string, unknown>,
  specific: Record<string, unknown> | undefined,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): PluginHookDecision | undefined {
  const sourceFormat = handler.sourceFormat;
  const additionalContext = readAdditionalContext(specific);
  if (specific?.additionalContext !== undefined && additionalContext === undefined)
    return undefined;
  const legacyDecision = value.decision;
  const legacyReason = readReason(value.reason);
  if (value.reason !== undefined && legacyReason === undefined) return undefined;
  const hasSpecificDecision =
    specific?.permissionDecision !== undefined ||
    specific?.permissionDecisionReason !== undefined ||
    specific?.updatedInput !== undefined;
  if (!hasSpecificDecision && legacyDecision !== undefined) {
    const allowedLegacy = ['approve', 'block'];
    if (!allowedLegacy.includes(String(legacyDecision))) return undefined;
    if (legacyDecision === 'block') {
      return legacyReason
        ? {
            ...base,
            decision: 'deny',
            reason: legacyReason,
            ...(additionalContext ? { additionalContext } : {}),
          }
        : undefined;
    }
    if (legacyReason !== undefined || sourceFormat === 'CODEX') return undefined;
    return { ...base, toolPermissionDecision: 'allow' };
  }
  if (!hasSpecificDecision && legacyReason !== undefined) return undefined;
  if (!specific) return base;
  const allowed = new Set([
    'hookEventName',
    'permissionDecision',
    'permissionDecisionReason',
    'updatedInput',
    'additionalContext',
  ]);
  if (Object.keys(specific).some((key) => !allowed.has(key))) return undefined;
  const permission = specific.permissionDecision;
  const supported =
    sourceFormat === 'CODEX' ? ['allow', 'deny'] : ['allow', 'deny', 'ask', 'defer'];
  if (permission !== undefined && !supported.includes(String(permission))) return undefined;
  const reason = readReason(specific.permissionDecisionReason);
  if (specific.permissionDecisionReason !== undefined && reason === undefined) return undefined;
  if (permission === undefined && reason !== undefined) return undefined;
  if (specific.updatedInput !== undefined && !isRecord(specific.updatedInput)) return undefined;
  const restoredUpdatedInput = isRecord(specific.updatedInput)
    ? restoreNativeToolInput(specific.updatedInput, handler, input)
    : undefined;
  if (specific.updatedInput !== undefined && restoredUpdatedInput === undefined) return undefined;
  if (sourceFormat === 'CODEX') {
    if (permission === 'allow' && specific.updatedInput === undefined) return undefined;
    if (permission === 'deny' && !reason) return undefined;
    if (specific.updatedInput !== undefined && permission !== 'allow') return undefined;
  }
  if (permission === 'defer') {
    return { ...base, decision: 'defer', toolPermissionDecision: 'defer' };
  }
  if (permission === 'deny') {
    return {
      ...base,
      decision: 'deny',
      ...(sourceFormat === 'CODEX' ? {} : { toolPermissionDecision: 'deny' as const }),
      ...(reason ? { reason } : {}),
      ...(additionalContext ? { additionalContext } : {}),
    };
  }
  if (permission === 'ask') {
    return {
      ...base,
      decision: 'ask',
      toolPermissionDecision: 'ask',
      ...(reason ? { reason } : {}),
      ...(restoredUpdatedInput ? { updatedInput: restoredUpdatedInput } : {}),
      ...(additionalContext ? { additionalContext } : {}),
    };
  }
  return {
    ...base,
    ...(permission === 'allow' && sourceFormat !== 'CODEX'
      ? { toolPermissionDecision: 'allow' as const }
      : {}),
    ...(reason ? { reason } : {}),
    ...(restoredUpdatedInput ? { updatedInput: restoredUpdatedInput } : {}),
    ...(additionalContext ? { additionalContext } : {}),
  };
}

function parsePostToolUseOutput(
  base: PluginHookDecision,
  value: Record<string, unknown>,
  specific: Record<string, unknown> | undefined,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
  additionalContext: string | undefined,
): PluginHookDecision | undefined {
  const sourceFormat = handler.sourceFormat;
  if (specific) {
    const allowed =
      sourceFormat === 'CLAUDE'
        ? new Set([
            'hookEventName',
            'additionalContext',
            'classifierContext',
            'updatedToolOutput',
            'updatedMCPToolOutput',
          ])
        : new Set(['hookEventName', 'additionalContext']);
    if (Object.keys(specific).some((key) => !allowed.has(key))) return undefined;
  }
  const topDecision = value.decision;
  const reason = readReason(value.reason);
  if (value.reason !== undefined && reason === undefined) return undefined;
  if (topDecision !== undefined && topDecision !== 'block') return undefined;
  if (topDecision === 'block' && !reason) return undefined;
  if (topDecision === undefined && reason !== undefined) return undefined;
  const updatedMcpOutput = specific?.updatedMCPToolOutput;
  if (updatedMcpOutput !== undefined && !isMcpToolInput(input)) return undefined;
  if (
    sourceFormat === 'CLAUDE' &&
    specific?.updatedToolOutput !== undefined &&
    !isMcpToolInput(input) &&
    !hasCompatibleJsonShape(input.payload?.compatible_tool_response, specific.updatedToolOutput)
  )
    return undefined;
  const replacement =
    sourceFormat === 'CLAUDE'
      ? firstDefined(specific?.updatedToolOutput, updatedMcpOutput)
      : undefined;
  if (sourceFormat === 'CODEX' && base.continue === false) {
    const stopReason = base.stopReason;
    const nonStoppingBase = withoutStoppingControls(base);
    return {
      ...nonStoppingBase,
      ...(additionalContext ? { additionalContext } : {}),
      postToolFeedback: reason ?? stopReason ?? 'PostToolUse Hook stopped normal processing.',
    };
  }
  if (topDecision === 'block' && reason) {
    return sourceFormat === 'CODEX'
      ? {
          ...base,
          postToolFeedback: reason,
          ...(additionalContext ? { additionalContext } : {}),
        }
      : {
          ...base,
          additionalContext: mergePluginHookContext(additionalContext, reason),
          ...(replacement !== undefined
            ? { updatedResult: replacement, updatedResultFormat: 'CLAUDE' as const }
            : {}),
        };
  }
  return {
    ...base,
    ...(additionalContext ? { additionalContext } : {}),
    ...(replacement !== undefined
      ? { updatedResult: replacement, updatedResultFormat: 'CLAUDE' as const }
      : {}),
  };
}

function withoutStoppingControls(decision: PluginHookDecision): PluginHookDecision {
  const result = { ...decision };
  delete result.continue;
  delete result.stopReason;
  return result;
}

function parseUniversalOutput(
  value: Record<string, unknown>,
  event: PluginHookEventInput['event'],
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
): Omit<PluginHookDecision, 'decision'> | undefined {
  if (value.continue !== undefined && typeof value.continue !== 'boolean') return undefined;
  if (value.stopReason !== undefined && typeof value.stopReason !== 'string') return undefined;
  if (value.suppressOutput !== undefined && typeof value.suppressOutput !== 'boolean')
    return undefined;
  if (value.systemMessage !== undefined && typeof value.systemMessage !== 'string')
    return undefined;
  // Compatible treats terminalSequence as an independent, best-effort side effect.
  // A malformed sequence must not invalidate an otherwise valid policy decision.
  const terminalSequence =
    sourceFormat === 'CLAUDE' &&
    typeof value.terminalSequence === 'string' &&
    isAllowedPluginHookTerminalSequence(value.terminalSequence)
      ? value.terminalSequence
      : undefined;
  if (sourceFormat === 'CLAUDE' && (event === 'PreCompact' || event === 'PostCompact')) {
    return terminalSequence ? { terminalSequence } : {};
  }
  if ((sourceFormat === 'CLAUDE' || sourceFormat === 'CODEX') && event === 'SessionEnd') {
    return terminalSequence ? { terminalSequence } : {};
  }
  if (sourceFormat === 'CODEX') {
    if (
      (event === 'PreToolUse' || event === 'PermissionRequest') &&
      (value.continue === false || value.stopReason !== undefined)
    )
      return undefined;
    if (
      (event === 'PreToolUse' || event === 'PermissionRequest' || event === 'PostToolUse') &&
      value.suppressOutput === true
    )
      return undefined;
  }
  const discardContinue =
    (sourceFormat === 'CODEX' && event === 'SubagentStart') ||
    (sourceFormat === 'CODEX' && event === 'SessionEnd') ||
    (sourceFormat === 'CLAUDE' &&
      (event === 'SessionStart' ||
        event === 'SubagentStart' ||
        event === 'PostCompact' ||
        event === 'SessionEnd'));
  return {
    ...(!discardContinue && value.continue === false ? { continue: false } : {}),
    ...(!discardContinue && value.continue === false && typeof value.stopReason === 'string'
      ? { stopReason: boundedReason(value.stopReason) }
      : {}),
    ...(value.suppressOutput === true ? { suppressOutput: true } : {}),
    ...(typeof value.systemMessage === 'string' ? { systemMessage: value.systemMessage } : {}),
    ...(terminalSequence ? { terminalSequence } : {}),
  };
}

/** Compatible permits bare BEL and OSC 0/1/2/9/99/777 terminated by BEL or ST. */
export function isAllowedPluginHookTerminalSequence(value: string): boolean {
  if (!value || value.length > 10_000) return false;
  let offset = 0;
  while (offset < value.length) {
    if (value.charCodeAt(offset) === 0x07) {
      offset += 1;
      continue;
    }
    if (value.charCodeAt(offset) !== 0x1b || value[offset + 1] !== ']') return false;
    const belTerminator = value.indexOf('\u0007', offset + 2);
    const stTerminator = value.indexOf('\u001b\\', offset + 2);
    const terminator =
      belTerminator < 0
        ? stTerminator
        : stTerminator < 0
          ? belTerminator
          : Math.min(belTerminator, stTerminator);
    if (terminator < 0) return false;
    const payload = value.slice(offset + 2, terminator);
    if (containsTerminalControlCharacter(payload)) return false;
    const separator = payload.indexOf(';');
    const command = separator < 0 ? payload : payload.slice(0, separator);
    if (!new Set(['0', '1', '2', '9', '99', '777']).has(command)) return false;
    offset = terminator + (terminator === stTerminator ? 2 : 1);
  }
  return true;
}

function containsTerminalControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Codex parses a schema-valid warning before it rejects a recognized but unsupported control.
 * Keep that warning, while leaving unknown or malformed wire shapes fully invalid.
 */
function codexUnsupportedControlSystemWarning(
  value: Record<string, unknown>,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): PluginHookDecision | undefined {
  if (handler.sourceFormat !== 'CODEX' || typeof value.systemMessage !== 'string') return undefined;
  if (
    input.event !== 'PreToolUse' &&
    input.event !== 'PermissionRequest' &&
    input.event !== 'PostToolUse'
  ) {
    return undefined;
  }
  if (!isSchemaValidCodexControlOutput(value, input.event)) return undefined;
  if (!hasUnsupportedCodexControl(value, input.event)) return undefined;
  return { ...defaultDecision(input.event), systemMessage: value.systemMessage };
}

function isSchemaValidCodexControlOutput(
  value: Record<string, unknown>,
  event: 'PreToolUse' | 'PermissionRequest' | 'PostToolUse',
): boolean {
  if (Object.keys(value).some((key) => !allowedWireOutputKeys(event, 'CODEX').has(key))) {
    return false;
  }
  if (value.continue !== undefined && typeof value.continue !== 'boolean') return false;
  if (!isOptionalString(value.stopReason)) return false;
  if (value.suppressOutput !== undefined && typeof value.suppressOutput !== 'boolean') return false;
  if (!isOptionalString(value.systemMessage)) return false;
  if (value.hookSpecificOutput !== undefined && value.hookSpecificOutput !== null) {
    if (!isRecord(value.hookSpecificOutput)) return false;
    const specific = value.hookSpecificOutput;
    if (specific.hookEventName !== event) return false;
    if (event === 'PreToolUse') {
      if (
        !hasOnlyKeys(specific, [
          'hookEventName',
          'additionalContext',
          'permissionDecision',
          'permissionDecisionReason',
          'updatedInput',
        ])
      ) {
        return false;
      }
      if (!isOptionalString(specific.additionalContext)) return false;
      if (!isOptionalString(specific.permissionDecisionReason)) return false;
      if (
        specific.permissionDecision !== undefined &&
        specific.permissionDecision !== null &&
        specific.permissionDecision !== 'allow' &&
        specific.permissionDecision !== 'deny' &&
        specific.permissionDecision !== 'ask'
      ) {
        return false;
      }
    } else if (event === 'PermissionRequest') {
      if (!hasOnlyKeys(specific, ['hookEventName', 'decision'])) return false;
      if (specific.decision !== undefined && specific.decision !== null) {
        if (!isRecord(specific.decision)) return false;
        const decision = specific.decision;
        if (
          !hasOnlyKeys(decision, [
            'behavior',
            'updatedInput',
            'updatedPermissions',
            'message',
            'interrupt',
          ])
        ) {
          return false;
        }
        if (decision.behavior !== 'allow' && decision.behavior !== 'deny') return false;
        if (!isOptionalString(decision.message)) return false;
        if (decision.interrupt !== undefined && typeof decision.interrupt !== 'boolean')
          return false;
      }
    } else {
      if (!hasOnlyKeys(specific, ['hookEventName', 'additionalContext', 'updatedMCPToolOutput'])) {
        return false;
      }
      if (!isOptionalString(specific.additionalContext)) return false;
    }
  }
  if (event === 'PermissionRequest') return true;
  if (value.decision !== undefined && value.decision !== null) {
    if (event === 'PreToolUse') {
      if (value.decision !== 'approve' && value.decision !== 'block') return false;
    } else if (value.decision !== 'block') {
      return false;
    }
  }
  return isOptionalString(value.reason);
}

function hasUnsupportedCodexControl(
  value: Record<string, unknown>,
  event: 'PreToolUse' | 'PermissionRequest' | 'PostToolUse',
): boolean {
  if (event !== 'PostToolUse' && (value.continue === false || hasNonNullValue(value.stopReason))) {
    return true;
  }
  if (value.suppressOutput === true) return true;
  const specific = isRecord(value.hookSpecificOutput) ? value.hookSpecificOutput : undefined;
  if (event === 'PermissionRequest') {
    const decision = isRecord(specific?.decision) ? specific.decision : undefined;
    return Boolean(
      decision &&
      (hasNonNullValue(decision.updatedInput) ||
        hasNonNullValue(decision.updatedPermissions) ||
        decision.interrupt === true),
    );
  }
  if (event === 'PostToolUse') {
    return Boolean(specific && hasNonNullValue(specific.updatedMCPToolOutput));
  }

  const permissionDecision = specific?.permissionDecision;
  const permissionReason = specific?.permissionDecisionReason;
  const updatedInputPresent = hasNonNullValue(specific?.updatedInput);
  const usesSpecificDecision =
    hasNonNullValue(permissionDecision) || hasNonNullValue(permissionReason) || updatedInputPresent;
  if (usesSpecificDecision) {
    if (updatedInputPresent && permissionDecision !== 'allow') return true;
    if (permissionDecision === 'allow') return !updatedInputPresent;
    if (permissionDecision === 'ask') return true;
    if (permissionDecision === 'deny') {
      return typeof permissionReason !== 'string' || !permissionReason.trim();
    }
    return hasNonNullValue(permissionReason);
  }
  if (value.decision === 'approve') return true;
  if (value.decision === 'block') {
    return typeof value.reason !== 'string' || !value.reason.trim();
  }
  return hasNonNullValue(value.reason);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function hasNonNullValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function allowedWireOutputKeys(
  event: PluginHookEventInput['event'],
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
): ReadonlySet<string> {
  const common = [
    'continue',
    'stopReason',
    'suppressOutput',
    'systemMessage',
    ...(sourceFormat === 'CLAUDE' ? ['terminalSequence'] : []),
  ];
  switch (event) {
    case 'SessionStart':
    case 'SubagentStart':
      return new Set([...common, 'hookSpecificOutput']);
    case 'UserPromptSubmit':
      return new Set([...common, 'decision', 'reason', 'hookSpecificOutput']);
    case 'PreToolUse':
      return new Set([...common, 'decision', 'reason', 'hookSpecificOutput']);
    case 'PermissionRequest':
      return new Set([...common, 'hookSpecificOutput']);
    case 'PostToolUse':
      return new Set([...common, 'decision', 'reason', 'hookSpecificOutput']);
    case 'Stop':
    case 'SubagentStop':
      return new Set([
        ...common,
        'decision',
        'reason',
        ...(sourceFormat === 'CLAUDE' || sourceFormat === 'MINIMAX' ? ['hookSpecificOutput'] : []),
      ]);
    case 'PreCompact':
      return new Set([...common, ...(sourceFormat === 'CODEX' ? [] : ['decision', 'reason'])]);
    case 'PostCompact':
    case 'SessionEnd':
      return new Set(common);
  }
}

function readAdditionalContext(value: Record<string, unknown> | undefined): string | undefined {
  if (!value || value.additionalContext === undefined) return undefined;
  return typeof value.additionalContext === 'string' ? value.additionalContext : undefined;
}

function isIgnoredCompatibleHookSpecificOutputKey(
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
  event: PluginHookEventInput['event'],
  key: string,
): boolean {
  if (sourceFormat !== 'CLAUDE') return false;
  if (event === 'SessionStart') {
    return ['initialUserMessage', 'sessionTitle', 'watchPaths', 'reloadSkills'].includes(key);
  }
  return event === 'UserPromptSubmit' && ['sessionTitle', 'suppressOriginalPrompt'].includes(key);
}

function readReason(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isCodexWinningReason(
  event: PluginHookEventInput['event'],
  decision: PluginHookDecision,
): boolean {
  if (!decision.reason) return false;
  if (event === 'PermissionRequest') return decision.permissionDecision === 'deny';
  return event === 'PreToolUse' && decision.decision === 'deny';
}

function supportsPlainTextContext(
  event: PluginHookEventInput['event'],
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
): boolean {
  if (event === 'SessionStart' || event === 'UserPromptSubmit') return true;
  return sourceFormat === 'CODEX' && event === 'SubagentStart';
}

function defaultDecision(event: PluginHookEventInput['event']): PluginHookDecision {
  return event === 'PermissionRequest'
    ? { decision: 'allow', permissionDecision: 'abstain' }
    : event === 'PreToolUse'
      ? { decision: 'allow', toolPermissionDecision: 'abstain' }
      : { decision: 'allow' };
}

function firstDefined(...values: readonly unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

export function mergePluginHookDecisions(
  current: PluginHookDecision,
  next: PluginHookDecision,
): PluginHookDecision {
  const decision = strongerDecision(current.decision, next.decision);
  const permissionDecision = strongerPermissionDecision(
    current.permissionDecision,
    next.permissionDecision,
  );
  const permissionAutoApproval = strongerPermissionAutoApproval(
    current.permissionAutoApproval,
    next.permissionAutoApproval,
  );
  const toolPermissionDecision = strongerToolPermissionDecision(
    current.toolPermissionDecision,
    next.toolPermissionDecision,
  );
  return {
    decision,
    ...(permissionDecision ? { permissionDecision } : {}),
    ...(permissionAutoApproval ? { permissionAutoApproval } : {}),
    ...(toolPermissionDecision ? { toolPermissionDecision } : {}),
    ...((next.reason ?? current.reason) ? { reason: next.reason ?? current.reason } : {}),
    ...((next.additionalContext ?? current.additionalContext)
      ? {
          additionalContext: mergePluginHookContext(
            current.additionalContext,
            next.additionalContext,
          ),
        }
      : {}),
    ...((next.updatedInput ?? current.updatedInput)
      ? { updatedInput: next.updatedInput ?? current.updatedInput }
      : {}),
    ...(current.updatedPermissions || next.updatedPermissions
      ? {
          updatedPermissions: [
            ...(current.updatedPermissions ?? []),
            ...(next.updatedPermissions ?? []),
          ],
        }
      : {}),
    ...((next.continuePrompt ?? current.continuePrompt)
      ? {
          continuePrompt: mergePluginHookContext(current.continuePrompt, next.continuePrompt),
        }
      : {}),
    ...((next.defer ?? current.defer) ? { defer: next.defer ?? current.defer } : {}),
    ...(current.continue === false || next.continue === false ? { continue: false } : {}),
    ...((next.stopReason ?? current.stopReason)
      ? { stopReason: next.stopReason ?? current.stopReason }
      : {}),
    ...(current.suppressOutput === true || next.suppressOutput === true
      ? { suppressOutput: true }
      : {}),
    ...((next.systemMessage ?? current.systemMessage)
      ? {
          systemMessage: mergePluginHookContext(current.systemMessage, next.systemMessage),
        }
      : {}),
    ...((next.terminalSequence ?? current.terminalSequence)
      ? {
          terminalSequence: `${current.terminalSequence ?? ''}${next.terminalSequence ?? ''}`,
        }
      : {}),
    ...((next.postToolFeedback ?? current.postToolFeedback)
      ? {
          postToolFeedback: mergePluginHookContext(current.postToolFeedback, next.postToolFeedback),
        }
      : {}),
    ...(current.interrupt === true || next.interrupt === true ? { interrupt: true } : {}),
    ...(next.updatedResult !== undefined
      ? {
          updatedResult: next.updatedResult,
          ...(next.updatedResultFormat ? { updatedResultFormat: next.updatedResultFormat } : {}),
        }
      : current.updatedResult !== undefined
        ? {
            updatedResult: current.updatedResult,
            ...(current.updatedResultFormat
              ? { updatedResultFormat: current.updatedResultFormat }
              : {}),
          }
        : {}),
  };
}

function strongerDecision(
  left: PluginHookDecision['decision'],
  right: PluginHookDecision['decision'],
): PluginHookDecision['decision'] {
  const rank: Record<PluginHookDecision['decision'], number> = {
    allow: 0,
    ask: 1,
    defer: 2,
    deny: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

function strongerPermissionDecision(
  left: PluginHookDecision['permissionDecision'],
  right: PluginHookDecision['permissionDecision'],
): PluginHookDecision['permissionDecision'] {
  const rank = { abstain: 0, allow: 1, deny: 2 } as const;
  if (!left) return right;
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

function strongerPermissionAutoApproval(
  left: PluginHookDecision['permissionAutoApproval'],
  right: PluginHookDecision['permissionAutoApproval'],
): PluginHookDecision['permissionAutoApproval'] {
  if (left === 'any_prompt' || right === 'any_prompt') return 'any_prompt';
  return right ?? left;
}

function strongerToolPermissionDecision(
  left: PluginHookDecision['toolPermissionDecision'],
  right: PluginHookDecision['toolPermissionDecision'],
): PluginHookDecision['toolPermissionDecision'] {
  const rank = { abstain: 0, allow: 1, ask: 2, defer: 3, deny: 4 } as const;
  if (!left) return right;
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

export function mergePluginHookContext(
  ...parts: readonly (string | undefined)[]
): string | undefined {
  const merged = parts.filter((part): part is string => Boolean(part)).join('\n');
  return merged ? boundedInjectedText(merged) : undefined;
}

export function composePluginHookToolResultContent<T>(
  originalContent: readonly T[],
  updatedResult: unknown,
  additionalContext?: string,
  options?: {
    readonly sourceFormat?: PluginHookDecision['updatedResultFormat'];
    readonly toolName?: string;
  },
): Array<T | { readonly type: 'text'; readonly text: string }> | undefined {
  const context = additionalContext?.trim();
  if (updatedResult === undefined && !context) return undefined;
  const content: Array<T | { readonly type: 'text'; readonly text: string }> =
    updatedResult === undefined ? [...originalContent] : [];
  if (updatedResult !== undefined) {
    const structuredContent =
      options?.sourceFormat === 'CLAUDE'
        ? readStructuredPluginHookToolContent(updatedResult)
        : undefined;
    if (structuredContent) {
      content.push(...(structuredContent as unknown as readonly T[]));
    } else {
      const text =
        options?.sourceFormat === 'CLAUDE'
          ? serializeCompatibleToolOutput(options.toolName, updatedResult)
          : safeToolResultOverrideText(updatedResult);
      if (text === undefined) content.push(...originalContent);
      else content.push({ type: 'text', text });
    }
  }
  if (context) {
    content.push({
      type: 'text',
      text: `<plugin-hook-context>\n${context}\n</plugin-hook-context>`,
    });
  }
  return content;
}

function serializeCompatibleToolOutput(
  toolName: string | undefined,
  value: unknown,
): string | undefined {
  if (!isRecord(value)) return undefined;
  if (toolName === 'bash') {
    if (
      typeof value.stdout !== 'string' ||
      typeof value.stderr !== 'string' ||
      typeof value.interrupted !== 'boolean' ||
      value.isImage !== false
    )
      return undefined;
    return [value.stdout, value.stderr, ...(value.interrupted ? ['Command interrupted'] : [])]
      .filter(Boolean)
      .join('\n');
  }
  return undefined;
}

/**
 * Preserve the model-facing `content` from an exact structured
 * `updatedToolOutput` (notably Plugin MCP CallToolResult) instead of flattening
 * it to JSON. This is independent of Compatible built-in response adaptation.
 */
function readStructuredPluginHookToolContent(
  value: unknown,
):
  | Array<
      | { readonly type: 'text'; readonly text: string }
      | { readonly type: 'image' | 'video'; readonly data: string; readonly mimeType: string }
    >
  | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  const content: Array<
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image' | 'video'; readonly data: string; readonly mimeType: string }
  > = [];
  for (const part of value.content) {
    if (!isRecord(part)) return undefined;
    if (part.type === 'text' && typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text });
      continue;
    }
    if (
      (part.type === 'image' || part.type === 'video') &&
      typeof part.data === 'string' &&
      typeof part.mimeType === 'string'
    ) {
      content.push({ type: part.type, data: part.data, mimeType: part.mimeType });
      continue;
    }
    return undefined;
  }
  return content;
}

function boundedInjectedText(value: string): string {
  return value.slice(0, MAX_INJECTED_TEXT_CHARS);
}

function serializeHookInput(input: PluginHookEventInput): string | undefined {
  try {
    const serialized = JSON.stringify({
      ...(input.payload ?? {}),
      hook_event_name: input.event,
      session_id: input.sessionId,
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      ...(input.promptId ? { prompt_id: input.promptId } : {}),
      transcript_path: input.transcriptPath ?? null,
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    });
    return Buffer.byteLength(serialized) <= MAX_INPUT_BYTES ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function isValidWireInput(handler: PluginHookCommandHandler, input: PluginHookEventInput): boolean {
  if (!input.sessionId || !input.cwd) return false;
  if (handler.sourceFormat === 'MINIMAX') return true;
  const payload = input.payload ?? {};
  const has = (key: string) =>
    Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined;
  const requiresTurn =
    handler.sourceFormat === 'CODEX' &&
    input.event !== 'SessionStart' &&
    input.event !== 'SessionEnd';
  if (requiresTurn && !input.turnId) return false;
  if (handler.sourceFormat === 'CODEX' && input.event !== 'SessionEnd' && !input.model) {
    return false;
  }
  const requiresPermissionMode =
    input.event !== 'SessionEnd' && input.event !== 'PreCompact' && input.event !== 'PostCompact';
  if (handler.sourceFormat === 'CODEX' && requiresPermissionMode && !input.permissionMode) {
    return false;
  }
  if (handler.sourceFormat === 'CLAUDE' && input.transcriptPath == null) return false;
  if (
    handler.sourceFormat === 'CLAUDE' &&
    requiresPermissionMode &&
    input.event !== 'SessionStart' &&
    input.event !== 'SubagentStart' &&
    !input.permissionMode
  )
    return false;
  switch (input.event) {
    case 'SessionStart':
      return has('source');
    case 'SessionEnd':
      return has('reason');
    case 'UserPromptSubmit':
      return has('prompt');
    case 'PreToolUse':
      return has('tool_name') && has('tool_input') && has('tool_use_id');
    case 'PermissionRequest':
      return has('tool_name') && has('tool_input');
    case 'PostToolUse':
      return has('tool_name') && has('tool_input') && has('tool_response') && has('tool_use_id');
    case 'SubagentStart':
      return has('agent_id') && has('agent_type');
    case 'SubagentStop':
      return (
        has('stop_hook_active') &&
        has('agent_id') &&
        has('agent_type') &&
        has('agent_transcript_path') &&
        has('last_assistant_message')
      );
    case 'Stop':
      return has('stop_hook_active') && has('last_assistant_message');
    case 'PreCompact':
      return has('trigger');
    case 'PostCompact':
      return (
        has('trigger') &&
        (handler.sourceFormat !== 'CLAUDE' || typeof payload.compact_summary === 'string')
      );
  }
}

function safeHookEnvironment(): NodeJS.ProcessEnv {
  const inherited = [
    'PATH',
    'HOME',
    'LANG',
    'TERM',
    'SHELL',
    'USER',
    'TMPDIR',
    'TEMP',
    'TMP',
    'PATHEXT',
    'SystemRoot',
    'ComSpec',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
  ];
  return Object.fromEntries(
    inherited.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function matches(handler: PluginHookCommandHandler, input: PluginHookEventInput): boolean {
  if (input.event === 'UserPromptSubmit' || input.event === 'Stop') return true;
  const pattern = handler.matcher;
  const values = matcherValues(handler, input);
  if (!pattern || pattern === '*') return true;
  if (pattern.length > 256) return false;
  if (values.length === 0 || values.some((value) => value.length > 256)) return false;
  if (handler.sourceFormat === 'CODEX' && /^[A-Za-z0-9_|]+$/u.test(pattern)) {
    const alternatives = pattern.split('|');
    return values.some((value) => alternatives.includes(value));
  }
  if (handler.sourceFormat === 'CLAUDE') {
    const alternatives = pattern.split(/[|,]/u).map((part) => part.trim());
    if (/^[A-Za-z0-9_\- ,|]+$/u.test(pattern)) {
      return values.some((value) => alternatives.includes(value));
    }
  } else if (handler.sourceFormat === 'MINIMAX') {
    const alternatives = pattern.split(/[|,]/u).map((part) => part.trim());
    if (alternatives.every((part) => /^[A-Za-z0-9_.:/-]+$/u.test(part))) {
      return values.some((value) => alternatives.includes(value));
    }
  }
  try {
    if (!isSafePluginHookMatcher(pattern)) return false;
    const regex = new RegExp(pattern, 'u');
    return values.some((value) => regex.test(value));
  } catch {
    return false;
  }
}

function matchesCondition(handler: PluginHookCommandHandler, input: PluginHookEventInput): boolean {
  if (!handler.condition) return true;
  const match = /^([A-Za-z0-9_.:/-]+)\(([^\r\n()]*)\)$/u.exec(handler.condition);
  if (!match?.[1] || match[2] === undefined) return false;
  if (!matcherValues(handler, input).includes(match[1])) return false;
  const adapted = adaptVendorInput(handler, input);
  const toolInput = adapted.payload?.tool_input;
  if (!isRecord(toolInput)) return false;
  const candidate = conditionCandidate(match[1], toolInput);
  if (candidate === undefined) return false;
  if (match[1] !== 'Bash') return globMatches(match[2], candidate);
  return bashPermissionRuleMatches(match[2], candidate);
}

/**
 * Compatible evaluates Bash permission-rule conditions against each simple
 * subcommand. This intentionally handles only commands that can be split
 * without shell parsing ambiguity; ambiguous input executes the Hook
 * conservatively instead of accidentally skipping a safety Hook.
 */
function bashPermissionRuleMatches(pattern: string, command: string): boolean {
  if (/['"\\]|\$\{|<<|>>|<\(|>\(/u.test(command)) return true;
  const substitutions = [
    ...[...command.matchAll(/\$\(([^()]*)\)/gu)].map((match) => match[1] ?? ''),
    ...[...command.matchAll(/`([^`]*)`/gu)].map((match) => match[1] ?? ''),
  ];
  const containsDynamicExpansion = substitutions.length > 0 || /\$[A-Za-z_]/u.test(command);
  const subcommands = [command, ...substitutions]
    .flatMap((candidate) => candidate.split(/\s*(?:&&|\|\||;|\n|\|)\s*/u))
    .map((part) => part.trim())
    .map(stripLeadingEnvironmentAssignments)
    .filter(Boolean);
  if (subcommands.length === 0) return true;
  const prefix = pattern.endsWith(':*') ? pattern.slice(0, -2).trim() : undefined;
  if (
    subcommands.some((subcommand) =>
      prefix
        ? subcommand === prefix || subcommand.startsWith(`${prefix} `)
        : globMatches(pattern, subcommand),
    )
  )
    return true;
  const patternWords = pattern.trim().split(/\s+/u);
  return containsDynamicExpansion && patternWords.length > 2;
}

function conditionCandidate(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): string | undefined {
  const key =
    toolName === 'Bash' || toolName === 'PowerShell'
      ? 'command'
      : toolName === 'WebFetch'
        ? 'url'
        : toolName === 'WebSearch'
          ? 'query'
          : toolName === 'Agent'
            ? 'subagent_type'
            : 'file_path';
  return typeof toolInput[key] === 'string' ? toolInput[key] : undefined;
}

function stripLeadingEnvironmentAssignments(command: string): string {
  return command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s'"`]+|'[^']*'|"[^"]*")\s+)+/u, '');
}

function globMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .split('')
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char;
    })
    .join('');
  try {
    return new RegExp(`^${expression}$`, 'u').test(value);
  } catch {
    return false;
  }
}

function expandHookPlaceholders(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (placeholder, name: string) => {
    const replacement = env[name];
    return replacement === undefined ? placeholder : replacement;
  });
}

function adaptVendorInput(
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): PluginHookEventInput {
  const payload = input.payload ?? {};
  const sourceFormat = handler.sourceFormat;
  const common = adaptCommonInputMetadata(input, sourceFormat);
  if (input.event === 'SessionStart') {
    const source = compatibleSessionStartSource(
      input.matcherValue ?? (typeof payload.source === 'string' ? payload.source : undefined),
      sourceFormat,
    );
    return {
      ...common,
      matcherValue: source,
      payload: pickVendorPayload({ ...payload, source }, ['source']),
    };
  }
  if (input.event === 'SessionEnd') {
    const reason = compatibleSessionEndReason(
      input.matcherValue ?? (typeof payload.reason === 'string' ? payload.reason : undefined),
      sourceFormat,
    );
    return {
      ...common,
      matcherValue: reason,
      payload: pickVendorPayload({ ...payload, reason }, ['reason']),
    };
  }
  if (
    input.event === 'PreToolUse' ||
    input.event === 'PermissionRequest' ||
    input.event === 'PostToolUse'
  ) {
    const tool = adaptToolIdentity(
      handler,
      input.event,
      payload,
      input.matcherValue,
      input.toolProvenance,
      input.cwd,
    );
    const subagentFields = ['agent_id', 'agent_type'];
    const keys =
      input.event === 'PermissionRequest'
        ? [
            ...subagentFields,
            'tool_name',
            'tool_input',
            ...(sourceFormat === 'CLAUDE' ? ['permission_suggestions'] : []),
          ]
        : input.event === 'PostToolUse'
          ? [
              ...subagentFields,
              'tool_name',
              'tool_input',
              'tool_response',
              'tool_use_id',
              ...(sourceFormat === 'CLAUDE' ? ['duration_ms'] : []),
            ]
          : [...subagentFields, 'tool_name', 'tool_input', 'tool_use_id'];
    return {
      ...common,
      matcherValue: tool.matcherValue,
      payload: pickVendorPayload(
        {
          ...payload,
          tool_name: tool.toolName,
          tool_input: tool.toolInput,
          permission_suggestions:
            sourceFormat === 'CLAUDE'
              ? compatiblePermissionSuggestions(tool.toolName, payload.permission_rule_contents)
              : undefined,
          tool_response:
            sourceFormat === 'CLAUDE'
              ? payload.compatible_tool_response
              : sourceFormat === 'CODEX'
                ? payload.codex_tool_response
                : (payload.tool_response ?? payload.tool_result),
        },
        keys,
      ),
    };
  }
  if (input.event === 'SubagentStart' || input.event === 'SubagentStop') {
    const agentType =
      typeof payload.agent_type === 'string'
        ? payload.agent_type
        : typeof payload.agent_name === 'string'
          ? payload.agent_name
          : input.matcherValue;
    const keys =
      input.event === 'SubagentStart'
        ? (['agent_id', 'agent_type'] as const)
        : ([
            'stop_hook_active',
            'agent_id',
            'agent_type',
            'agent_transcript_path',
            'last_assistant_message',
            ...(sourceFormat === 'CLAUDE' ? ['background_tasks', 'session_crons'] : []),
          ] as const);
    return {
      ...common,
      payload: pickVendorPayload({ ...payload, agent_type: agentType }, keys),
    };
  }
  const vendorPayloadKeys: Partial<Record<PluginHookEventInput['event'], readonly string[]>> = {
    UserPromptSubmit: ['prompt'],
    Stop: [
      'stop_hook_active',
      'last_assistant_message',
      ...(sourceFormat === 'CLAUDE' ? ['background_tasks', 'session_crons'] : []),
    ],
    PreCompact: ['trigger', ...(sourceFormat === 'CLAUDE' ? ['custom_instructions'] : [])],
    PostCompact: ['trigger', ...(sourceFormat === 'CLAUDE' ? ['compact_summary'] : [])],
  };
  return {
    ...common,
    payload: pickVendorPayload(
      input.event === 'PreCompact' && sourceFormat === 'CLAUDE'
        ? {
            ...payload,
            custom_instructions:
              typeof payload.custom_instructions === 'string' ? payload.custom_instructions : '',
          }
        : payload,
      vendorPayloadKeys[input.event] ?? [],
    ),
  };
}

function compatiblePermissionSuggestions(
  toolName: string | undefined,
  value: unknown,
): readonly unknown[] | undefined {
  if (
    !toolName ||
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((rule) => typeof rule === 'string' && rule.trim().length > 0)
  ) {
    return undefined;
  }
  return [
    {
      type: 'addRules',
      rules: value.map((ruleContent) => ({ toolName, ruleContent })),
      behavior: 'allow',
      // MiniMax's persisted global permission store is equivalent to Compatible's
      // per-user settings destination. Keep Compatible's public wire vocabulary on
      // the Hook boundary so a suggestion can be echoed as updatedPermissions.
      destination: 'userSettings',
    },
  ];
}

function adaptCommonInputMetadata(
  input: PluginHookEventInput,
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
): PluginHookEventInput {
  const subagentContext = input.subagentContext;
  const usesParentAgentSession =
    sourceFormat !== 'MINIMAX' &&
    subagentContext !== undefined &&
    (input.event === 'SubagentStart' || input.event === 'SubagentStop');
  const codexTurnScoped = input.event !== 'SessionStart' && input.event !== 'SessionEnd';
  const hasPermissionMode =
    sourceFormat === 'CLAUDE'
      ? input.event === 'UserPromptSubmit' ||
        input.event === 'PreToolUse' ||
        input.event === 'PermissionRequest' ||
        input.event === 'PostToolUse' ||
        input.event === 'Stop' ||
        input.event === 'SubagentStop'
      : input.event !== 'SessionEnd' &&
        input.event !== 'PreCompact' &&
        input.event !== 'PostCompact';
  const hasCompatibleEffort =
    sourceFormat === 'CLAUDE' &&
    (input.event === 'PreToolUse' ||
      input.event === 'PermissionRequest' ||
      input.event === 'PostToolUse' ||
      input.event === 'SubagentStart' ||
      input.event === 'SubagentStop' ||
      input.event === 'Stop');
  return {
    ...input,
    sessionId: usesParentAgentSession ? subagentContext.parentSessionId : input.sessionId,
    transcriptPath:
      sourceFormat === 'CODEX'
        ? usesParentAgentSession
          ? subagentContext.parentCodexTranscriptPath
          : input.codexTranscriptPath
        : usesParentAgentSession
          ? subagentContext.parentTranscriptPath
          : input.transcriptPath,
    turnId:
      sourceFormat === 'CLAUDE'
        ? undefined
        : codexTurnScoped
          ? usesParentAgentSession
            ? subagentContext.parentTurnId
            : input.turnId
          : undefined,
    promptId: sourceFormat === 'CLAUDE' ? input.promptId : undefined,
    model:
      sourceFormat === 'CLAUDE'
        ? input.event === 'SessionStart'
          ? input.model
          : undefined
        : input.event === 'SessionEnd'
          ? undefined
          : input.model,
    permissionMode: hasPermissionMode
      ? compatiblePermissionMode(input.permissionMode, sourceFormat)
      : undefined,
    effort: hasCompatibleEffort ? input.effort : undefined,
  };
}

function matcherValues(
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): readonly string[] {
  const adapted = adaptVendorInput(handler, input).matcherValue;
  if (!adapted) return [];
  if (handler.sourceFormat !== 'CODEX') return [adapted];
  if (adapted === 'apply_patch') return [adapted, 'Write', 'Edit'];
  if (adapted === 'spawn_agent') return [adapted, 'Agent'];
  return [adapted];
}

function compatiblePermissionMode(
  value: string | undefined,
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
): string | undefined {
  if (!value) return undefined;
  if (value === 'off') return 'bypassPermissions';
  if (sourceFormat === 'CODEX' && value === 'auto') return 'default';
  const supported =
    sourceFormat === 'CODEX'
      ? new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'])
      : new Set(['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']);
  return supported.has(value) ? value : 'default';
}

function pickVendorPayload(
  payload: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    keys.flatMap((key) =>
      Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined
        ? [[key, payload[key]]]
        : [],
    ),
  );
}

function compatibleSessionStartSource(
  value: string | undefined,
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
): string | undefined {
  if (value === 'plugin_activation') return 'startup';
  if (sourceFormat === 'CODEX' && value === 'fork') return 'resume';
  return value;
}

function compatibleSessionEndReason(
  value: string | undefined,
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
): string | undefined {
  if (sourceFormat === 'CODEX') return 'other';
  if (value === 'resume_other') return 'resume';
  if (value === 'archive' || value === 'idle_timeout') return 'other';
  return value;
}

function isEventSupportedBySource(
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): boolean {
  if (
    input.event === 'PostToolUse' &&
    handler.sourceFormat === 'CODEX' &&
    input.payload?.tool_name === 'bash'
  ) {
    const details = isRecord(input.payload.tool_result)
      ? input.payload.tool_result.details
      : undefined;
    const status = isRecord(details) ? details.status : undefined;
    if (status === 'background_started' || status === 'started') return false;
  }
  if (input.event !== 'PostToolUse' || input.payload?.is_error !== true) return true;
  // Compatible reserves PostToolUse for successful executions and exposes
  // failures through PostToolUseFailure. Codex deliberately sends non-zero
  // Bash results through PostToolUse, so only Compatible is filtered here.
  if (handler.sourceFormat === 'CLAUDE') return false;
  return true;
}

const MAX_CONCURRENT_COMMANDS = 8;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value === undefined) continue;
        results[index] = await operation(value);
      }
    }),
  );
  return results;
}

function needsPostToolAdapter(
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): boolean {
  if (handler.event !== 'PostToolUse' || input.event !== 'PostToolUse') return false;
  if (!isEventSupportedBySource(handler, input)) return false;
  if (handler.sourceFormat === 'CLAUDE') {
    return !isRecord(input.payload?.compatible_tool_response);
  }
  if (handler.sourceFormat === 'CODEX') return input.payload?.codex_tool_response === undefined;
  return false;
}

function withPostToolAdapterEvidence(
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): PluginHookEventInput {
  const evidence =
    handler.sourceFormat === 'CLAUDE'
      ? { compatible_tool_response: {} }
      : handler.sourceFormat === 'CODEX'
        ? { codex_tool_response: '' }
        : {};
  return {
    ...input,
    payload: { ...(input.payload ?? {}), ...evidence },
  };
}

function compareHandlers(left: PluginHookCommandHandler, right: PluginHookCommandHandler): number {
  return (
    left.pluginName.localeCompare(right.pluginName) ||
    left.sourcePath.localeCompare(right.sourcePath) ||
    left.declarationOrder - right.declarationOrder
  );
}

function runDiagnostic(
  handler: PluginHookCommandHandler,
  code: PluginHookRunDiagnostic['code'],
): PluginHookRunDiagnostic {
  return {
    code,
    pluginName: handler.pluginName,
    sourcePath: handler.sourcePath,
    event: handler.event,
    declarationOrder: handler.declarationOrder,
  };
}

export function renderPluginHookRejectionReminder(reason?: string): string {
  const detail = escapeXmlText(
    boundedReason(reason?.trim() || 'A Plugin Hook rejected this queued prompt.'),
  );
  return [
    '<plugin-hook-rejection>',
    'A Plugin Hook rejected a queued user prompt before it reached the model.',
    `Reason: ${detail}`,
    'Briefly tell the user that the queued prompt was rejected and why. Do not claim to have processed the rejected prompt.',
    '</plugin-hook-rejection>',
  ].join('\n');
}

function boundedReason(value: string): string {
  return value.slice(0, MAX_REASON_CHARS);
}

function escapeXmlText(value: string): string {
  return value.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeHookOutputValue(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    if (visited > MAX_OUTPUT_VALUE_NODES || current.depth > MAX_OUTPUT_VALUE_DEPTH) return false;
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const [key, child] of Object.entries(current.value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') return false;
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function safeToolResultOverrideText(value: unknown): string | undefined {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text !== undefined && text.length <= MAX_INJECTED_TEXT_CHARS ? text : undefined;
  } catch {
    return undefined;
  }
}
