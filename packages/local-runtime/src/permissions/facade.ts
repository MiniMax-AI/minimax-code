/**
 * LocalPermissionFacade — permission orchestration backed by the deterministic
 * checkers + the cloud gateway.
 *
 * The split:
 *   - Deterministic layer: `PermissionEngine` dispatches
 *     `BashToolPermissionChecker` / `FsToolPermissionChecker`; Permission Core
 *     is the default final reducer. Together they produce all rule contents
 *     (`bash(npm publish:*)`), rewrittenInput (`rm` → `mavis-trash`), and
 *     bypass-immune flags; these define every wire shape (UI, route JSON,
 *     persisted rules).
 *   - Decision layer: the `PermissionMode` (`default` / `auto` /
 *     `bypassPermissions`) is mapped to an `AskForApproval` policy
 *     (`on-request` / `on-request-llm` / `never`) for policy clarity, but the
 *     flow is routed through `PermissionEngine.checkPermission(...)` with a
 *     snapshotted `core` (default) or `engine` (rollback) policy owner.
 *   - LLM layer: `auto` mode consults `HttpCloudGatewayClient` →
 *     `POST /mavis/api/v1/permission/check`. acceptEdits is normalized to
 *     `default` at entry.
 *
 * `LocalPermissionApprovalService` owns pending/dedupe/waiter/persistence;
 * routes only adapt the typed `permission.ask` product-event flow. The facade is a pure
 * synchronous-ish decision function from their POV (modulo the cloud gateway
 * await for `auto` mode).
 */

import path from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';

import {
  PermissionEngine,
  reducePermissionClassifierDecision,
  registerDefaultCheckers,
  HttpCloudGatewayClient,
  modeToAskPolicy,
  renderConversationContext,
  formatDecisionReason,
  formatAutoClassifierReason,
  createToolPermissionContext,
  createPermissionExecutionPlan,
  shouldUseCloudClassify,
  detectMessagesLocale,
  type CloudGatewayClient,
  type CloudClassifyVerdict,
  type UserLocaleHint,
  type ToolDenialSource,
  type DecisionReason,
  type PermissionDecision,
  type ExecutionPlan,
  type WindowsNativeDeleteCommand,
  type PermissionMode,
  type PermissionBehavior,
  type PermissionRule,
  matchHardBlockedBash,
  isRmCommand,
  splitCommand,
  parseWindowsNativeDelete,
} from '@mavis/permission';
import type { AgentMessageProtocol } from '@mavis/agent-core/protocol/agent-message';

import type { LocalPermissionMessageSource } from './service.js';
import { LocalPermissionStoreUnhealthyError, type LocalPermissionRuleStore } from './rules.js';
import type {
  LocalPluginHookEffectivePermissions,
  LocalPluginHookPermissionMutationInput,
  LocalPluginHookPermissionStore,
} from './plugin-hook-permissions.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import type { MetricsClient } from '../common/metrics.js';
import { logger } from '../common/logger.js';
import { readLocalPermissionMode } from '../api/host-helpers.js';
import { applyAskGate } from './ask-gate.js';
import { selectMatchingRule } from './rule-match.js';
import {
  hasWindowsWriteOrDeleteCommand,
  hasWindowsWriteRedirection,
  evaluateLocalPermissionCheck,
  evaluateWindowsPathSafetyCheck,
  expandWindowsCommandSurfaces,
  splitWindowsCommandSegments,
} from './checkers.js';
import { inspectTrashRuntime } from '../infra/ensure-trash-script.js';

function readPermissionPolicyOwner(value: unknown): 'engine' | 'core' {
  if (value === undefined || value === 'core') return 'core';
  return 'engine';
}

/**
 * Convert a structured decision reason into diagnostic fields. Bash
 * subcommands retain their command and safety detail so operators can explain
 * an allow/ask/deny without consulting messages.jsonl. Top-level filesystem
 * reasons still omit raw paths and free-form descriptions.
 */
function permissionReasonLogFields(
  reason: DecisionReason,
  includeSafetyDetail = false,
): Record<string, unknown> {
  const reasonCode: Record<DecisionReason['type'], string> = {
    rule: 'persisted_rule',
    safetyCheck: 'safety_check',
    workingDirectory: 'working_directory_boundary',
    internalWhitelist: 'internal_whitelist',
    trustedExactWrite: 'trusted_exact_write',
    tempDirectory: 'temp_directory',
    sandbox: 'sandbox',
    mode: 'permission_mode',
    pathValidation: 'path_validation',
    dangerousRemoval: 'dangerous_removal',
    subcommandResults: 'subcommand_results',
    rmRewrite: 'recoverable_delete_rewrite',
    recoverableDeleteRewrite: 'recoverable_delete_rewrite',
  };
  const fields: Record<string, unknown> = { reason_code: reasonCode[reason.type] };
  if (reason.type === 'rule') {
    fields.rule_source = reason.rule.source;
    fields.rule_behavior = reason.rule.ruleBehavior;
    fields.rule_tool_name = reason.rule.ruleValue.toolName;
    fields.rule_has_content = Boolean(reason.rule.ruleValue.ruleContent);
  } else if (reason.type === 'mode') {
    fields.reason_mode = reason.mode;
  } else if (reason.type === 'safetyCheck') {
    if (includeSafetyDetail) fields.reason_detail = reason.description;
    if (reason.category) fields.reason_category = reason.category;
  } else if (reason.type === 'subcommandResults') {
    fields.subcommand_results = [...reason.reasons].map(([command, result]) => ({
      command,
      behavior: result.behavior,
      reason_type: result.reason.type,
      ...permissionReasonLogFields(result.reason, true),
    }));
  }
  return fields;
}

function readCommand(input: Record<string, unknown>): string | undefined {
  return typeof input.command === 'string'
    ? input.command
    : typeof input.cmd === 'string'
      ? input.cmd
      : undefined;
}

function commandSurfaces(command: string): string[] {
  return [...new Set(expandWindowsCommandSurfaces(command))];
}

function findWindowsDeleteReason(
  command: string,
  recoverableNativeDelete: boolean,
): string | undefined {
  if (recoverableNativeDelete) return undefined;
  return commandSurfaces(command)
    .map((candidate) => matchHardBlockedBash(candidate))
    .find((hit) => hit?.category === 'windows-delete')?.description;
}

function readLeadingExecutable(command: string): string | undefined {
  const program = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command);
  return program?.[1] ?? program?.[2] ?? program?.[3];
}

function parseWindowsShellFamily(command: string): 'cmd' | 'powershell' | undefined {
  const executable = readLeadingExecutable(command)?.toLowerCase();
  if (!executable) return undefined;
  const base = path.win32.basename(executable).replace(/\.(?:exe|cmd|bat)$/i, '');
  if (base === 'cmd') return 'cmd';
  if (base === 'powershell' || base === 'pwsh') return 'powershell';
  return undefined;
}

function resolveWindowsShellFamily(
  command: string,
  hostShellFamily: 'cmd' | 'powershell' | undefined,
): 'cmd' | 'powershell' | undefined {
  // A wrapper carries explicit provenance for its payload. Bare commands must
  // use the host-provided executor shell; never infer CMD/PowerShell from
  // `del`, `rd`, `Remove-Item`, or any other command name.
  return parseWindowsShellFamily(command) ?? hostShellFamily;
}

function isMavisTrashExecutable(command: string): boolean {
  const executable = readLeadingExecutable(command);
  if (!executable) return false;
  return (
    path.win32
      .basename(executable)
      .replace(/\.(?:cmd|bat|exe)$/i, '')
      .toLowerCase() === 'mavis-trash'
  );
}

function isRecoverableDeleteInsideWorkspace(
  targets: readonly string[],
  workspaceDir: string,
): boolean {
  const workspace = path.win32
    .normalize(workspaceDir)
    .toLowerCase()
    .replace(/[\\/]$/, '');
  return targets.every((target) => {
    const normalized = path.win32
      .normalize(target)
      .toLowerCase()
      .replace(/[\\/]$/, '');
    if (
      /^[a-z]:\\?$/i.test(normalized) ||
      /^[a-z]:\\(?:windows|program files(?: \(x86\))?)(?:\\|$)/i.test(normalized)
    ) {
      return false;
    }
    return normalized === workspace || normalized.startsWith(`${workspace}\\`);
  });
}

/**
 * A single surface (already expanded by `commandSurfaces`) is delete-like
 * if its leading executable would delete files: bash `rm`, PowerShell
 * `Remove-Item` / `ri` / `remove`, Windows CMD `del` / `erase` / `rmdir`
 * / `rd`, POSIX `unlink` / `shred`, or the recoverable `mavis-trash`
 * launcher itself. This is the set the safety net must audit segment by
 * segment — see `everyDeleteSegmentIsSafelyRewritable`.
 */
function isDeleteLikeSegment(surface: string): boolean {
  return (
    /^\s*(?:rm|rmdir|rd|del|erase|remove-item|ri|remove|unlink|shred)\b/i.test(surface) ||
    isMavisTrashExecutable(surface)
  );
}

function isDeleteLikeCommand(command: string): boolean {
  return commandSurfaces(command).some(isDeleteLikeSegment);
}

function commandContainsRmSegment(command: string): boolean {
  return isRmCommand(command) || splitCommand(command).some((segment) => isRmCommand(segment));
}

function normalizeWindowsExecutablePath(executable: string): string {
  return path.win32.normalize(executable.replaceAll('/', '\\')).toLowerCase();
}

function hasUntrustedMavisTrashExecutable(command: string, launcherPath: string): boolean {
  const expectedLauncher = normalizeWindowsExecutablePath(launcherPath);
  return commandSurfaces(command).some((surface) => {
    if (!isMavisTrashExecutable(surface)) return false;
    const executable = readLeadingExecutable(surface);
    return Boolean(executable && normalizeWindowsExecutablePath(executable) !== expectedLauncher);
  });
}

/**
 * Every delete-like segment in a compound Windows command must independently
 * resolve to a safe deletion path — either a bare `rm` that the engine will
 * rewrite into `mavis-trash <path>` further down the pipeline, or the exact
 * canonical `mavis-trash.cmd` absolute path emitted by that rewrite.
 *
 * Without a per-segment audit, a compound command like
 *   "<dataDir>\bin\mavis-trash.cmd" -- .\a && unlink .\b
 * would sneak the `unlink` permanent delete past the boundary because the
 * only trash surface (segment 1) satisfies the trusted-launcher check, and
 * `unlink` is not in the row-anchored windows-delete hard-regex nor the
 * recursive workspace check.
 *
 * The `rm` case is subtle. The engine rewrites `rm ...` at the top of a
 * subcommand — so a top-level `rm ... && ...` still gets rewritten, but
 * `cmd /c "rm ..."` does NOT (the rewrite cannot reach into a wrapper
 * payload). Wrapper unwrap exposes the inner `rm` as an extra surface for
 * the HARD hard-regex scan, but the actual invocation is still `cmd /c "rm
 * ..."` at shell launch — no rewrite happens. So `rm` is only trusted when
 * the surface is itself a top-level segment, not a wrapper-payload surface.
 */
function everyDeleteSegmentIsSafelyRewritable(
  command: string,
  launcherPath: string,
  shellFamily: 'cmd' | 'powershell' | undefined,
): boolean {
  const expectedLauncher = normalizeWindowsExecutablePath(launcherPath);
  const topLevelSegments = new Set(splitWindowsCommandSegments(command));
  const surfaces = commandSurfaces(command);
  const deleteSurfaces = surfaces.filter(isDeleteLikeSegment);
  if (deleteSurfaces.length === 0) return true;

  return deleteSurfaces.every((surface) => {
    // Canonical absolute launcher is always safe — the exact executable
    // the rm rewrite emits. Bare `mavis-trash` / any other basename is
    // NOT accepted here (Windows CWD-first resolution risk).
    if (isMavisTrashExecutable(surface)) {
      const executable = readLeadingExecutable(surface)!;
      return normalizeWindowsExecutablePath(executable) === expectedLauncher;
    }
    // Bare `rm` is safe ONLY when this surface is itself a top-level
    // subcommand segment (the rm rewrite runs on the top-level command;
    // it cannot reach into `cmd /c "rm ..."` or `bash -c "rm ..."`
    // payloads). Wrapper-payload rm surfaces bubbled up by
    // unwrapCommandWrappers are informational for the hard-regex scan
    // and must not be trusted here.
    if (isRmCommand(surface) && topLevelSegments.has(surface)) return true;
    if (
      topLevelSegments.size === 1 &&
      topLevelSegments.has(surface) &&
      parseWindowsNativeDelete(surface, shellFamily)
    )
      return true;
    return false;
  });
}

function needsWindowsPathSafetyCheck(
  toolName: string,
  input: Record<string, unknown>,
  command?: string,
): boolean {
  if (['read', 'glob', 'grep', 'list'].includes(toolName)) return false;
  if (command) {
    return hasWindowsWriteRedirection(command) || hasWindowsWriteOrDeleteCommand(command);
  }
  return [input.path, input.filePath, input.file_path].some((value) => typeof value === 'string');
}

// ---------------------------------------------------------------------------
// Public output shape — the PermissionService return type consumed by routes
// and the pi-turn-runner call sites.
// ---------------------------------------------------------------------------

export interface LocalPermissionCheckResult {
  behavior: PermissionBehavior;
  reason: string;
  /**
   * True only for an ordinary fallback approval prompt. A compatible
   * PreToolUse/PermissionRequest Hook may answer this prompt on the user's
   * behalf. Explicit ask rules and product safety prompts intentionally omit
   * this flag, so Hook output cannot bypass them.
   */
  hookAutoApprovalEligible?: boolean;
  requestId?: string;
  ruleContents?: string[];
  ruleMatchers?: PermissionDecision['ruleMatchers'];
  toolInput?: string;
  toolDescription?: string;
  rewrittenInput?: Record<string, unknown>;
  /** Complete immutable input contract consumed by the production execution gate. */
  executionPlan?: Readonly<ExecutionPlan>;
  /**
   * Origin of a `deny` verdict, used by the `beforeToolCall` hook to render
   * a source-tagged denial string for the LLM. Only set when
   * `behavior === 'deny'`; `'user'` is attributed by the route layer (the
   * facade never sees the dialog reply), so this narrows to the
   * facade-decidable subset.
   */
  denySource?: Exclude<ToolDenialSource, 'user'>;
}

export interface LocalPermissionCheckParams {
  toolName: string;
  input: Record<string, unknown>;
  agentName?: string;
  sessionId?: string;
  permissionModeOverride?: PermissionMode;
  latestUserMessages?: AgentMessageProtocol[];
  recentMessages?: AgentMessageProtocol[];
  /** Trusted owner-only capability; never populated from public HTTP input. */
  trustedExactWritePaths?: readonly string[];
}

interface WindowsHardSafetyResult {
  denial?: LocalPermissionCheckResult;
  recoverableNativeDelete?: WindowsNativeDeleteCommand;
  workingDirectory?: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface LocalPermissionFacadeDeps {
  ruleStore: LocalPermissionRuleStore;
  pluginHookPermissionStore?: LocalPluginHookPermissionStore;
  configGetter: () => LocalRuntimeConfig;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  getLocalAgent: (agentName: string) => Promise<{ defaultWorkspaceDir?: string } | undefined>;
  messageStore?: LocalPermissionMessageSource;
  /**
   * Optional override for tests — swap the cloud gateway for an in-memory
   * client. Production never passes this; the facade default-constructs an
   * HttpCloudGatewayClient pointing at the
   * /mavis/api/v1/permission/check endpoint via region routing.
   */
  cloudGateway?: CloudGatewayClient;
  /** Per-call cloud-gateway timeout (ms). Default 60_000. */
  cloudGatewayTimeoutMs?: number;
  /**
   * Optional metrics sink (bare metric names; the server-side pipeline owns
   * the `local_runtime_` prefix). Absent = noop, zero behavior change.
   */
  metricsClient?: MetricsClient;
  /** Test/runtime override; production uses the actual host platform. */
  platform?: NodeJS.Platform;
  /** Actual shell family used by the host executor; unknown keeps native delete fail-closed. */
  shellFamily?: 'cmd' | 'powershell';
  /** Test-only trash health probe override; production invokes mavis-trash.cmd. */
  trashRuntimeProbe?: (scriptPath: string, launcherPath: string) => boolean;
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

export class LocalPermissionFacade {
  private readonly deps: LocalPermissionFacadeDeps;
  private readonly cloudGateway: CloudGatewayClient;
  private readonly engine: PermissionEngine;
  private readonly cloudGatewayTimeoutMs: number;

  constructor(deps: LocalPermissionFacadeDeps) {
    this.deps = deps;
    this.cloudGatewayTimeoutMs = deps.cloudGatewayTimeoutMs ?? 60_000;
    this.cloudGateway =
      deps.cloudGateway ?? new HttpCloudGatewayClient({ timeoutMs: this.cloudGatewayTimeoutMs });
    this.engine = new PermissionEngine();
    registerDefaultCheckers(this.engine);
  }

  /**
   * Decision entrypoint. Consumed by routes and the pi-turn-runner
   * beforeToolCall hook.
   *
   * This is a thin wrapper. The actual decision pipeline lives in
   * {@link checkPermissionRaw}; this wrapper exists solely to feed
   * the raw verdict through {@link applyAskGate} so the
   * `bypassPermissions` ("Always allow") invariant — _no card ever
   * surfaces in this mode_ — is enforced in one place rather than
   * scattered across the 22 sites that can produce `behavior: 'ask'`.
   *
   * The mode is snapshotted ONCE at this entrypoint and threaded into
   * the raw pipeline and the gate. `configGetter()` is a live view of
   * daemon config, and `PUT /config { permissionMode: ... }` can flip
   * it mid-call between two `await` boundaries; reading it twice would
   * let the raw pipeline and the gate disagree about which mode is
   * active. In the worst case (user tightens `bypassPermissions` →
   * `default` mid-call), a stale `'bypassPermissions'` snapshot in the
   * gate would downgrade a freshly-asked credential read to ALLOW.
   *
   * If you need to read the unmodified verdict (tests, telemetry,
   * future debug surfaces), call {@link checkPermissionRaw} directly.
   */
  async checkPermission(params: LocalPermissionCheckParams): Promise<LocalPermissionCheckResult> {
    const config = this.deps.configGetter();
    const pluginContext = await this.resolvePluginHookPermissionContext(params);
    const rawMode =
      pluginContext.mode ??
      params.permissionModeOverride ??
      readLocalPermissionMode(config.permissionMode);
    const policyOwner = readPermissionPolicyOwner(config.permission?.policyOwner);

    const verdict = await this.checkPermissionRaw(params, rawMode, policyOwner, pluginContext);
    // acceptEdits is normalized to default inside the raw pipeline, but
    // the gate cares only about bypassPermissions; passing the raw mode
    // through unchanged is correct.
    const gatedVerdict = applyAskGate(verdict, rawMode);
    let finalVerdict: LocalPermissionCheckResult = gatedVerdict;
    if (
      gatedVerdict.behavior !== 'deny' &&
      (rawMode !== 'off' || gatedVerdict.rewrittenInput !== undefined)
    ) {
      finalVerdict = {
        ...gatedVerdict,
        executionPlan: createPermissionExecutionPlan({
          toolName: params.toolName,
          input: params.input,
          ...(gatedVerdict.rewrittenInput ? { rewrittenInput: gatedVerdict.rewrittenInput } : {}),
          shell: this.deps.shellFamily ?? 'unknown',
          context: {
            workingDirectory: await this.resolveWorkingDirectory(
              params.sessionId,
              params.agentName,
            ),
            homeDir: homedir(),
          },
        }),
      };
    }
    logger.info(
      {
        ...(params.sessionId ? { session_id: params.sessionId } : {}),
        tool_name: params.toolName,
        permission_mode: rawMode,
        policy_owner: policyOwner,
        raw_behavior: verdict.behavior,
        final_behavior: finalVerdict.behavior,
        ask_gate_applied: verdict.behavior !== finalVerdict.behavior,
        rewrite_applied: Boolean(finalVerdict.rewrittenInput),
        execution_plan_present: Boolean(finalVerdict.executionPlan),
        transform_count: finalVerdict.executionPlan?.transforms.length ?? 0,
        raw_rule_count: verdict.ruleContents?.length ?? 0,
        ...(finalVerdict.denySource ? { deny_source: finalVerdict.denySource } : {}),
      },
      'permission.decision',
    );
    return finalVerdict;
  }

  /**
   * The unmodified decision pipeline. Returns whatever the chain
   * (runtime safety boundary → off short-circuit → engine →
   * cloud-gateway for `auto`) decides, including `ask` verdicts that
   * would otherwise be downgraded under bypassPermissions.
   *
   * `effectiveMode` is the mode snapshot the caller wants this call to
   * use. {@link checkPermission} threads in a single snapshot so the
   * raw pipeline and the ask-gate cannot disagree across an `await`
   * boundary when the user flips `PUT /config { permissionMode }`
   * mid-decision. External callers (tests, telemetry) can omit it; the
   * pipeline then falls back to a fresh `configGetter()` read — fine
   * for non-prod, but never re-used across the gate.
   *
   * Only {@link checkPermission} and tests should call this directly.
   */
  async checkPermissionRaw(
    params: LocalPermissionCheckParams,
    effectiveMode?: PermissionMode,
    effectivePolicyOwner?: 'engine' | 'core',
    resolvedPluginContext?: LocalPluginHookEffectivePermissions,
  ): Promise<LocalPermissionCheckResult> {
    const config = this.deps.configGetter();
    const pluginContext =
      resolvedPluginContext ?? (await this.resolvePluginHookPermissionContext(params));
    const rawMode =
      pluginContext.mode ??
      effectiveMode ??
      params.permissionModeOverride ??
      readLocalPermissionMode(config.permissionMode);
    const policyOwner =
      effectivePolicyOwner ?? readPermissionPolicyOwner(config.permission?.policyOwner);
    const platform = this.deps.platform ?? process.platform;
    let workingDirectory: string | undefined;

    const command = readCommand(params.input);
    const windowsHardSafety = await this.evaluateWindowsHardSafety(params, platform, command);
    if (windowsHardSafety.denial) return windowsHardSafety.denial;
    const { recoverableNativeDelete } = windowsHardSafety;
    workingDirectory = windowsHardSafety.workingDirectory;

    const posixTrashSafety = this.evaluatePosixTrashSafety(platform, command);
    if (posixTrashSafety) return posixTrashSafety;

    // Off mode skips the whole pipeline (cloud autonomy).
    const windowsDeleteNeedsRewrite =
      platform === 'win32' && command !== undefined && isDeleteLikeCommand(command);
    const posixDeleteNeedsRewrite =
      (platform === 'darwin' || platform === 'linux') &&
      command !== undefined &&
      commandContainsRmSegment(command);
    if (rawMode === 'off' && !windowsDeleteNeedsRewrite && !posixDeleteNeedsRewrite) {
      return {
        behavior: 'allow',
        reason: 'Allowed: permission mode is off; permission review was skipped.',
      };
    }

    // acceptEdits is an alias for default with seeded allow rules.
    // Never propagate acceptEdits into the engine.
    const mode: PermissionMode =
      rawMode === 'acceptEdits' ? 'default' : rawMode === 'off' ? 'bypassPermissions' : rawMode;
    const askPolicy = modeToAskPolicy(mode);

    // Coarse user-locale hint so the rendered reason matches the user's
    // language: sniff inline messages first, fall back to the session's
    // recent messages. We use the inline hints only here; the cloud-classifier
    // path below already loads recent messages for conversation_context and
    // re-uses them.
    const localeHint = this.resolveInlineLocaleHint(params);

    // Snapshot rules + build the ToolPermissionContext.
    let rules: PermissionRule[];
    try {
      rules = [
        ...(await this.deps.ruleStore.listRules({
          agentName: params.agentName,
          sessionId: params.sessionId,
        })),
        ...pluginContext.rules,
      ] as PermissionRule[];
    } catch (error) {
      if (!(error instanceof LocalPermissionStoreUnhealthyError)) throw error;
      logger.warn(
        {
          ...(params.sessionId ? { session_id: params.sessionId } : {}),
          tool_name: params.toolName,
          source: error.source,
          reason: error.reasonCode,
        },
        'permission.store.unhealthy',
      );
      const reason = `Permission rule store is unhealthy (${error.reasonCode}); approval is required.`;
      return rawMode === 'bypassPermissions'
        ? { behavior: 'deny', reason, denySource: 'safety' }
        : { behavior: 'ask', reason };
    }
    if (workingDirectory === undefined) {
      workingDirectory = await this.resolveWorkingDirectory(params.sessionId, params.agentName);
    }

    const ctx = createToolPermissionContext({
      mode,
      rules,
      workingDirectory,
      allowedWorkingPaths: [...pluginContext.directories],
      sandboxAllowPaths: this.resolveSandboxAllowPaths(
        params.toolName,
        workingDirectory,
        params.agentName,
      ),
      trustedExactWritePaths: params.trustedExactWritePaths,
      dataDir: this.deps.configGetter().dataDir,
      homeDir: homedir(),
      isFile: (p: string) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      },
      agentName: params.agentName,
      sessionId: params.sessionId,
      platform,
      shellFamily: this.deps.shellFamily ?? 'unknown',
    });

    // Local-runtime-only safety net. Splits into two kinds so we don't
    // regress "Always allow":
    //
    //   - bypass-immune  → UNC/network-share access, recursive deletion of
    //     `/` or `~`. Stays a deny across every askPolicy because no user
    //     toggle should make these reachable.
    //
    //   - policy        → sensitive credential paths (`~/.ssh`, `*.pem`,
    //     …). Under bypassPermissions we skip it entirely so the engine's
    //     fast-allow / rule store can speak; under default/auto we let the
    //     engine run first and demote allow → ask so the cloud gateway or
    //     the user can clear it (routes to the LLM gate, per bash-fast-allow).
    //
    //   - ask           → curl-pipe-shell, shell substitution, slow
    //     unbounded scan, recursive rm, workspace-escape. Same upgrade
    //     allow → ask logic as before; ASK was never bypass-immune.
    const localHardCheck = evaluateLocalPermissionCheck({
      toolName: params.toolName,
      input: params.input,
      workspaceDir: workingDirectory,
      platform,
    });
    if (
      localHardCheck?.behavior === 'deny' &&
      localHardCheck.denyKind === 'bypass-immune' &&
      !recoverableNativeDelete
    ) {
      return { behavior: 'deny', reason: localHardCheck.reason, denySource: 'safety-immune' };
    }

    // Run the deterministic engine. Output carries:
    //   - behavior (allow / ask / deny)
    //   - reason (structured DecisionReason — rendered with reason-format)
    //   - ruleContents (BashChecker/FsChecker normalized — e.g. "npm publish:*")
    //   - rewrittenInput (rm → mavis-trash)
    //   - skipAutoClassifier (defensive net — keep ask out of LLM)
    const decision = this.engine.checkPermission(params.toolName, params.input, ctx, {
      policyOwner,
      onCheckerDecision: (trace) => {
        logger.info(
          {
            ...(params.sessionId ? { session_id: params.sessionId } : {}),
            tool_name: params.toolName,
            permission_mode: mode,
            policy_owner: policyOwner,
            checker_registered: trace.checkerRegistered,
            checker_behavior: trace.checkerBehavior,
            ...(params.toolName === 'bash' && command ? { command } : {}),
            ...(trace.reasonType ? { reason_type: trace.reasonType } : {}),
            ...(trace.reason
              ? permissionReasonLogFields(trace.reason, params.toolName === 'bash')
              : {}),
            rewrite_applied: trace.rewriteApplied,
            rule_count: trace.ruleCount,
            skip_auto_classifier: trace.skipAutoClassifier,
          },
          'permission.checker.decision',
        );
      },
    });
    logger.info(
      {
        ...(params.sessionId ? { session_id: params.sessionId } : {}),
        tool_name: params.toolName,
        permission_mode: mode,
        policy_owner: policyOwner,
        policy_behavior: decision.behavior,
        ...(params.toolName === 'bash' && command ? { command } : {}),
        reason_type: decision.reason.type,
        ...permissionReasonLogFields(decision.reason, params.toolName === 'bash'),
        rewrite_applied: Boolean(decision.rewrittenInput),
        rule_count: decision.ruleContents?.length ?? 0,
        skip_auto_classifier: decision.skipAutoClassifier === true,
      },
      `permission.${policyOwner}.decision`,
    );

    // policy deny (sensitive credential path) under default/auto — demote
    // allow → ask so the LLM gate / user can authorize. Under
    // bypassPermissions we skip this branch so the engine's allow stays
    // allow (matches "Always allow" semantics).
    //
    // Exception: when the user has a persisted allow rule that matches this
    // tool call (either via the engine's rule match or the local rule store's
    // content-specific matching — e.g. web_fetch(*)), the user has explicitly
    // authorized this tool; overriding it back to ask would make the stored
    // rule ineffective and cause repeated permission popups on every call
    // despite the user clicking "Always allow".
    if (
      askPolicy !== 'never' &&
      localHardCheck?.behavior === 'deny' &&
      localHardCheck.denyKind === 'policy' &&
      decision.behavior === 'allow' &&
      decision.reason.type !== 'rule' &&
      !hasMatchingLocalAllowRule(rules, params.toolName, params.input)
    ) {
      return {
        behavior: 'ask',
        reason: localHardCheck.reason,
      };
    }

    // bypassPermissions ('never') no longer needs an `allow → ask`
    // upgrade for local hard-check ASKs. The ask-gate
    // ({@link applyAskGate}) now sits at the public entrypoint and
    // downgrades any ASK verdict back to ALLOW when
    // `mode === 'bypassPermissions'`. Honouring the local checker's
    // ASK here would only be visible through `checkPermissionRaw`
    // (tests, telemetry); it stays a no-op for the production path.

    // ALLOW / DENY — return as-is, render reason from structured DecisionReason.
    if (decision.behavior === 'allow') {
      return {
        behavior: 'allow',
        reason: formatDecisionReason(decision.reason, 'allow', localeHint),
        rewrittenInput: decision.rewrittenInput,
      };
    }
    if (decision.behavior === 'deny') {
      return {
        behavior: 'deny',
        reason: formatDecisionReason(decision.reason, 'deny', localeHint),
        denySource: classifyDenySource(decision.reason),
      };
    }

    // ASK — fold with askPolicy.
    const baseAsk: LocalPermissionCheckResult = {
      behavior: 'ask',
      reason: formatDecisionReason(decision.reason, 'ask', localeHint),
      ruleContents: decision.ruleContents,
      ruleMatchers: decision.ruleMatchers,
      rewrittenInput: decision.rewrittenInput,
      ...(isOrdinaryFallbackAsk(decision.reason) ? { hookAutoApprovalEligible: true } : {}),
    };

    // 'never' (Always allow / bypassPermissions): the raw pipeline still
    // returns ASK so the engine's intent is visible to telemetry /
    // tests via `checkPermissionRaw`; the public-entry ask-gate then
    // downgrades it to ALLOW, matching the "Always allow = no card ever"
    // invariant. The bypass-immune deny set (UNC, root rm) short-
    // circuited at facade:202 — it never reaches this branch.
    if (askPolicy === 'never') {
      return baseAsk;
    }

    if (askPolicy === 'deny') {
      return {
        behavior: 'deny',
        reason: `Denied by dontAsk permission mode: ${baseAsk.reason}`,
        denySource: 'rule',
      };
    }

    // 'on-request' (Ask / default): emit ask immediately.
    if (askPolicy === 'on-request') {
      return baseAsk;
    }

    const logClassifierDecision = (
      classifierVerdict: string,
      recommendationBehavior: 'allow' | 'ask',
      skipReason?: 'policy' | 'unavailable',
    ): void => {
      logger.info(
        {
          ...(params.sessionId ? { session_id: params.sessionId } : {}),
          tool_name: params.toolName,
          policy_owner: policyOwner,
          classifier_verdict: classifierVerdict,
          recommendation_behavior: recommendationBehavior,
          ...(skipReason ? { skip_reason: skipReason } : {}),
        },
        'permission.classifier.decision',
      );
    };

    // 'on-request-llm' (Smart approval / auto): consult cloud gateway BEFORE ask.
    // Cloud classify only fires in managed runtime contexts (a configured
    // Bearer token resolver). Pure local dev daemons + tests fall through to
    // ask so they don't hang on a real HTTP call.
    if (decision.skipAutoClassifier || !shouldUseCloudClassify()) {
      logClassifierDecision(
        'skipped',
        'ask',
        decision.skipAutoClassifier ? 'policy' : 'unavailable',
      );
      return baseAsk;
    }

    const conversationContext = await this.buildConversationContext(
      params.sessionId,
      params.latestUserMessages,
      params.recentMessages,
    );
    // Hardening: even though HttpCloudGatewayClient fails closed on every
    // documented error branch, we wrap classifyViaCloud in a catch-all so
    // any unexpected runtime throw (e.g. region-resolver glitch on first
    // boot, AbortError before fetch is created) still routes to ASK rather
    // than bubbling out and killing the turn.
    let gatewayVerdict: CloudClassifyVerdict;
    const classifyStartedAt = Date.now();
    try {
      gatewayVerdict = await this.classifyViaCloud({
        toolName: params.toolName,
        command: serializeToolInput(params.toolName, params.input),
        workspaceRoot: workingDirectory,
        conversationContext,
        sessionId: params.sessionId,
        agentName: params.agentName,
      });
    } catch {
      this.emitLlmCheckMetrics('error', classifyStartedAt);
      logClassifierDecision('error', 'ask');
      return mapClassifierRecommendation(
        decision,
        'ask',
        formatAutoClassifierReason(
          'timeout',
          formatTimeoutSuffixSeconds(this.cloudGatewayTimeoutMs),
          localeHint,
        ),
        policyOwner,
      );
    }
    this.emitLlmCheckMetrics(gatewayVerdict.kind, classifyStartedAt);
    logClassifierDecision(gatewayVerdict.kind, gatewayVerdict.kind === 'allow' ? 'allow' : 'ask');

    switch (gatewayVerdict.kind) {
      case 'allow':
        return mapClassifierRecommendation(
          decision,
          'allow',
          formatAutoClassifierReason('allow', gatewayVerdict.reasonLocalized, localeHint),
          policyOwner,
        );
      case 'block':
        return mapClassifierRecommendation(
          decision,
          'ask',
          formatAutoClassifierReason('block', gatewayVerdict.reasonLocalized, localeHint),
          policyOwner,
        );
      case 'confirm':
        return mapClassifierRecommendation(
          decision,
          'ask',
          formatAutoClassifierReason('confirm', gatewayVerdict.reasonLocalized, localeHint),
          policyOwner,
        );
      case 'timeout':
      default:
        // Surface the client's reasonLocalized as the suffix so 5xx /
        // network / abort failures stay distinguishable on the UI card
        // and in daemon logs. The client already prefixes its reason
        // with "timed out", "permission/check returned 500",
        // "permission/check biz error", etc.
        return mapClassifierRecommendation(
          decision,
          'ask',
          formatAutoClassifierReason(
            'timeout',
            gatewayVerdict.reasonLocalized ||
              formatTimeoutSuffixSeconds(this.cloudGatewayTimeoutMs),
            localeHint,
          ),
          policyOwner,
        );
    }
  }

  /**
   * acceptEdits alias seeder.
   *
   * Seeds `edit/write/apply_patch=allow` rules at startup AND on every
   * setMode('acceptEdits'): callers invoke this both at startup
   * (createLocalPermissionService) and after
   * `PUT /config { permissionMode: 'acceptEdits' }` so a runtime mode
   * switch does not have to wait for a daemon restart to take effect.
   *
   * Idempotent: each global rule is only added when missing.
   */
  async syncAcceptEditsSeed(): Promise<void> {
    return this.runStartupAliasSeed();
  }

  /**
   * Startup-only entrypoint kept for backwards compatibility with
   * createLocalPermissionService; aliased to `syncAcceptEditsSeed`.
   */
  async runStartupAliasSeed(): Promise<void> {
    const cfg = this.deps.configGetter();
    const mode = readLocalPermissionMode(cfg.permissionMode);
    if (mode !== 'acceptEdits') return;
    const existing = await this.deps.ruleStore.listRules({});
    const targets: Array<{ toolName: 'edit' | 'write' | 'apply_patch' }> = [
      { toolName: 'edit' },
      { toolName: 'write' },
      { toolName: 'apply_patch' },
    ];
    const missing = targets.filter(
      (t) =>
        !existing.some(
          (r) =>
            r.source === 'global' &&
            r.ruleBehavior === 'allow' &&
            r.ruleValue.toolName === t.toolName &&
            !r.ruleValue.ruleContent,
        ),
    );
    if (missing.length === 0) return;
    await this.deps.ruleStore.applyUpdate({
      type: 'addRules',
      source: 'global',
      destination: 'global',
      behavior: 'allow',
      rules: missing,
    });
  }

  async applyPluginHookPermissionUpdates(
    input: Omit<LocalPluginHookPermissionMutationInput, 'bypassAvailable'>,
  ): Promise<void> {
    const store = this.deps.pluginHookPermissionStore;
    if (!store) throw new Error('Plugin Hook permission mutation store is unavailable.');
    const configuredMode = readLocalPermissionMode(this.deps.configGetter().permissionMode);
    await store.applyAtomic({
      ...input,
      bypassAvailable: configuredMode === 'bypassPermissions' || configuredMode === 'off',
    });
  }

  async clearPluginHookSessionPermissions(sessionId: string): Promise<void> {
    await this.deps.pluginHookPermissionStore?.clearSession(sessionId);
  }

  private async resolvePluginHookPermissionContext(
    params: LocalPermissionCheckParams,
  ): Promise<LocalPluginHookEffectivePermissions> {
    const store = this.deps.pluginHookPermissionStore;
    if (!store) return { rules: [], directories: [] };
    const cwd = await this.resolveWorkingDirectory(params.sessionId, params.agentName);
    return await store.effective({
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      cwd,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Built-in skill assets may be read without granting access to private runtime state. */
  private resolveSandboxAllowPaths(
    toolName: string,
    workingDirectory: string,
    agentName?: string,
  ): string[] {
    // Read-only tool set parity with `READ_ONLY_TOOLS`
    // (`packages/local-runtime/src/permission/tools/fs-permission.ts`).
    // We don't import it directly to avoid coupling facade construction
    // to engine module load order; if the set changes upstream, the
    // sandbox helper here needs to stay in sync.
    const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'glob', 'grep', 'list']);
    if (!READ_ONLY_TOOLS.has(toolName)) return [];

    const candidates: string[] = [];
    const dataDir = this.deps.configGetter().dataDir;
    for (const root of [dataDir, path.join(homedir(), '.minimax')]) {
      if (!root) continue;
      candidates.push(path.resolve(root, 'skills'), path.resolve(root, '.builtin-skills'));
      if (agentName) candidates.push(path.resolve(root, 'agents', agentName, 'skills'));
    }
    // De-duplicate (dataDir may already equal <dataDir> on a default install).
    const unique = Array.from(new Set(candidates));
    if (!workingDirectory) return unique;
    const resolvedWorkspace = path.resolve(workingDirectory);
    return unique.filter((candidate) => {
      // Drop candidates that would shadow the workspace boundary check.
      const withSep = candidate.endsWith(path.sep) ? candidate : candidate + path.sep;
      return !resolvedWorkspace.startsWith(withSep) && resolvedWorkspace !== candidate;
    });
  }

  private async classifyViaCloud(input: {
    toolName: string;
    command: string;
    workspaceRoot: string;
    conversationContext: string;
    sessionId?: string;
    agentName?: string;
  }): Promise<CloudClassifyVerdict> {
    return this.cloudGateway.classify({
      toolName: input.toolName,
      input: input.command,
      platform: process.platform,
      homeDir: homedir(),
      workspaceRoot: input.workspaceRoot,
      mode: 'auto',
      conversationContext: input.conversationContext,
      agentId: input.agentName,
      sessionId: input.sessionId,
    });
  }

  /** `verdict` = CloudClassifyVerdict.kind or 'error' for an unexpected throw. */
  private emitLlmCheckMetrics(verdict: string, startedAtMs: number): void {
    const metrics = this.deps.metricsClient;
    if (!metrics) return;
    metrics.histogram('permission_llm_check_duration_ms', Date.now() - startedAtMs);
    metrics.counter('permission_llm_check_total', 1, { verdict });
  }

  private async resolveWorkingDirectory(
    sessionId: string | undefined,
    agentName: string | undefined,
  ): Promise<string> {
    let resolvedAgent = agentName;
    if (sessionId) {
      const session = await this.deps.getSessionById(sessionId);
      if (session?.workspaceDir) return session.workspaceDir;
      resolvedAgent = resolvedAgent ?? session?.agentName;
    }
    if (resolvedAgent) {
      const agent = await this.deps.getLocalAgent(resolvedAgent);
      if (agent?.defaultWorkspaceDir) return agent.defaultWorkspaceDir;
      return path.join(this.deps.configGetter().dataDir, 'agents', resolvedAgent, 'workspace');
    }
    return homedir();
  }

  /**
   * Resolves only an actual session or agent workspace. In particular, it
   * never returns the general permission-context fallback (home/dataDir),
   * because that fallback must not become a write/delete safety boundary.
   */
  private async resolveExplicitWorkspaceDirectory(
    sessionId: string | undefined,
    agentName: string | undefined,
  ): Promise<string | undefined> {
    let resolvedAgent = agentName;
    if (sessionId) {
      const session = await this.deps.getSessionById(sessionId);
      if (session?.workspaceDir) return session.workspaceDir;
      resolvedAgent = resolvedAgent ?? session?.agentName;
    }
    if (!resolvedAgent) return undefined;
    return (await this.deps.getLocalAgent(resolvedAgent))?.defaultWorkspaceDir;
  }

  /**
   * Runtime-boundary Windows safety net. It runs before permission mode handling,
   * so `off`, bypass, persisted rules and user approval cannot authorize an
   * unrecoverable delete or a protected-path write.
   */
  private async evaluateWindowsHardSafety(
    params: LocalPermissionCheckParams,
    platform: NodeJS.Platform,
    command: string | undefined,
  ): Promise<WindowsHardSafetyResult> {
    if (platform !== 'win32') return {};

    const recoverableDeleteInstruction =
      'Deletion intent detected. Do not bypass this denial with another permanent delete command, wrapper, script, or filesystem API. ' +
      'Retry only through a simple, top-level recoverable deletion that the runtime can route through its trusted mavis-trash launcher.';
    const unavailableTrashInstruction =
      'Deletion intent detected. The target was not deleted. Do not fall back to any permanent delete command, wrapper, script, or filesystem API. ' +
      'Re-check mavis-trash availability before retrying and use only the trusted local-runtime launcher. ' +
      'If mavis-trash remains unavailable, tell the user that the target must be removed manually.';

    const shellFamily = command
      ? resolveWindowsShellFamily(command, this.deps.shellFamily)
      : undefined;
    // Emergency policy rollback: setting this to `undefined` rejects the entire
    // proven native-delete subset without removing downstream parser/transform
    // support or its audit evidence.
    const recoverableNativeDelete = command
      ? parseWindowsNativeDelete(command, shellFamily)
      : undefined;

    if (command) {
      const permanentDeleteReason = findWindowsDeleteReason(
        command,
        Boolean(recoverableNativeDelete),
      );
      if (permanentDeleteReason) {
        return {
          denial: {
            behavior: 'deny',
            reason: `Local hard safety policy blocked ${params.toolName}: ${permanentDeleteReason}. Use mavis-trash for recoverable removal; permanent Windows delete commands are not allowed. ${recoverableDeleteInstruction}`,
            denySource: 'safety-immune',
          },
        };
      }

      if (isDeleteLikeCommand(command)) {
        const dataDir = this.deps.configGetter().dataDir;
        const trash = inspectTrashRuntime(dataDir, platform, this.deps.trashRuntimeProbe);
        if (!trash.available) {
          return {
            denial: {
              behavior: 'deny',
              reason: `Local hard safety policy blocked deletion: the Windows mavis-trash launcher is unavailable (${trash.reason ?? 'health check failed'}). The agent must not fall back to a permanent delete command. ${unavailableTrashInstruction}`,
              denySource: 'safety-immune',
            },
          };
        }
        const launcherPath = path.win32.join(dataDir, 'bin', 'mavis-trash.cmd');
        if (hasUntrustedMavisTrashExecutable(command, launcherPath)) {
          return {
            denial: {
              behavior: 'deny',
              reason: `Local hard safety policy blocked deletion: bare or non-canonical mavis-trash is untrusted because PATH/CWD may select a different executable. The target was not deleted. Retry with one top-level rm command; the runtime will use the trusted launcher at "${launcherPath}". Do not bypass this with a permanent delete command, wrapper, script, or filesystem API.`,
              denySource: 'safety-immune',
            },
          };
        }
        if (!everyDeleteSegmentIsSafelyRewritable(command, launcherPath, shellFamily)) {
          return {
            denial: {
              behavior: 'deny',
              reason: `Local hard safety policy blocked a wrapped or compound Windows delete command that cannot be safely rewritten. Use the trusted local-runtime mavis-trash launcher for recoverable removal. ${recoverableDeleteInstruction}`,
              denySource: 'safety-immune',
            },
          };
        }
      }
    }

    if (!needsWindowsPathSafetyCheck(params.toolName, params.input, command)) {
      return recoverableNativeDelete ? { recoverableNativeDelete } : {};
    }

    const workingDirectory = await this.resolveExplicitWorkspaceDirectory(
      params.sessionId,
      params.agentName,
    );
    const pathSafety = evaluateWindowsPathSafetyCheck({
      toolName: params.toolName,
      input: params.input,
      workspaceDir: workingDirectory,
      platform,
    });
    const recoverableInsideWorkspace =
      recoverableNativeDelete !== undefined &&
      workingDirectory !== undefined &&
      isRecoverableDeleteInsideWorkspace(recoverableNativeDelete.targets, workingDirectory);
    if (pathSafety && !recoverableInsideWorkspace) {
      return {
        denial: {
          behavior: 'deny',
          reason: pathSafety.reason,
          denySource: 'safety-immune',
        },
      };
    }
    return {
      ...(recoverableNativeDelete ? { recoverableNativeDelete } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
    };
  }

  /**
   * POSIX rm relies on the bundled trash script for recoverability. Keep this
   * health boundary ahead of permission-mode shortcuts so deletion cannot
   * silently fall back to an irreversible shell command.
   */
  private evaluatePosixTrashSafety(
    platform: NodeJS.Platform,
    command: string | undefined,
  ): LocalPermissionCheckResult | undefined {
    if (
      (platform !== 'darwin' && platform !== 'linux') ||
      command === undefined ||
      !commandContainsRmSegment(command)
    ) {
      return undefined;
    }

    const dataDir = this.deps.configGetter().dataDir;
    const trash = inspectTrashRuntime(dataDir, platform);
    if (trash.available) return undefined;
    const scriptPath = path.join(dataDir, 'bin', 'mavis-trash');
    return {
      behavior: 'deny',
      reason:
        'Recoverable deletion is unavailable, so this delete was blocked rather than ' +
        `performed permanently (${trash.reason ?? 'health check failed'}).\n` +
        `Runtime script: ${scriptPath}\n` +
        'How to restore it:\n' +
        `  1. Remove ${scriptPath} and restart the app — startup re-seeds the script.\n` +
        '  2. If it fails again, verify the runtime data directory is writable and not ' +
        'mounted noexec, and that the script keeps its execute bit.\n' +
        "  3. Two app versions sharing one data directory overwrite each other's script; " +
        'close the other version, then restart.',
      denySource: 'safety-immune',
    };
  }

  /**
   * Coarse user-locale hint from inline messages.
   *
   * Inline-only by design, to avoid burning a store round-trip on the deny /
   * allow fast paths. The cloud-classifier path below already pulls recent
   * messages from the store via `buildConversationContext`; in practice an
   * inline hint is supplied by the daemon's HTTP route (it forwards
   * `recent_user_messages`), so the inline path covers the live wire. The
   * fallback returns `'unknown'`, which the formatter renders as the English
   * template for messageless sessions.
   */
  private resolveInlineLocaleHint(params: LocalPermissionCheckParams): UserLocaleHint {
    const inline = params.latestUserMessages ?? params.recentMessages;
    if (!inline || inline.length === 0) return 'unknown';
    return detectMessagesLocale(inline);
  }

  private async buildConversationContext(
    sessionId: string | undefined,
    inlineLatest?: AgentMessageProtocol[],
    inlineRecent?: AgentMessageProtocol[],
  ): Promise<string> {
    if (inlineLatest !== undefined || inlineRecent !== undefined) {
      return renderConversationContext({
        latestUserMessages: inlineLatest,
        recentMessages: inlineRecent,
      });
    }
    if (!sessionId || !this.deps.messageStore) return '';
    try {
      const [latest, recent] = await Promise.all([
        this.deps.messageStore.listRecentDisplayMessages(sessionId, {
          limit: 3,
          role: 'user',
          excludePermissionResponses: true,
        }),
        this.deps.messageStore.listRecentDisplayMessages(sessionId, { limit: 5 }),
      ]);
      return renderConversationContext({
        latestUserMessages: latest,
        recentMessages: recent,
      });
    } catch {
      return '';
    }
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Hooks may answer only the same ordinary fallback prompt that Compatible Code
 * allows a Hook to auto-approve. An explicit ask rule, a product safety
 * boundary, or any compound command containing either remains owned by the
 * user-facing permission flow.
 */
function isOrdinaryFallbackAsk(reason: DecisionReason): boolean {
  if (reason.type === 'workingDirectory') return true;
  if (reason.type === 'safetyCheck') return reason.category === 'noMatchingPermissionRule';
  if (reason.type !== 'subcommandResults') return false;

  let sawAsk = false;
  for (const subcommand of reason.reasons.values()) {
    if (subcommand.behavior === 'deny') return false;
    if (subcommand.behavior !== 'ask') continue;
    sawAsk = true;
    if (!isOrdinaryFallbackAsk(subcommand.reason)) return false;
  }
  return sawAsk;
}

/**
 * Map an engine `deny` {@link DecisionReason} to its LLM-facing source tag.
 * A `rule` reason is a user-configured deny rule; everything else
 * (safetyCheck / dangerousRemoval / pathValidation / …) is a built-in safety
 * boundary. For a compound bash command the reason is a `subcommandResults`
 * map — we attribute it to the first `deny` subcommand's inner reason
 * (deny sorts first, matching {@link formatSubcommandDecisionReason}).
 */
function classifyDenySource(reason: DecisionReason): Exclude<ToolDenialSource, 'user'> {
  if (reason.type === 'rule') return 'rule';
  if (reason.type === 'subcommandResults') {
    for (const sub of reason.reasons.values()) {
      if (sub.behavior === 'deny') {
        return sub.reason.type === 'rule' ? 'rule' : 'safety';
      }
    }
    return 'safety';
  }
  return 'safety';
}

function mapClassifierRecommendation(
  decision: PermissionDecision,
  behavior: 'allow' | 'ask',
  reason: string,
  policyOwner: 'engine' | 'core',
): LocalPermissionCheckResult {
  const reduced =
    policyOwner === 'core'
      ? reducePermissionClassifierDecision(decision, {
          behavior,
          reason: { type: 'safetyCheck', description: reason },
        })
      : behavior === 'allow'
        ? {
            behavior: 'allow' as const,
            reason: { type: 'safetyCheck' as const, description: reason },
            rewrittenInput: decision.rewrittenInput,
          }
        : { ...decision, reason: { type: 'safetyCheck' as const, description: reason } };
  if (reduced.behavior === 'deny') {
    return {
      behavior: 'deny',
      reason: formatDecisionReason(reduced.reason, 'deny'),
      denySource: classifyDenySource(reduced.reason),
    };
  }
  if (reduced.behavior === 'allow') {
    return {
      behavior: 'allow',
      reason,
      rewrittenInput: reduced.rewrittenInput,
    };
  }
  return {
    behavior: 'ask',
    reason,
    ruleContents: reduced.ruleContents,
    ruleMatchers: reduced.ruleMatchers,
    rewrittenInput: reduced.rewrittenInput,
  };
}

function serializeToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash' && typeof input.command === 'string') {
    return input.command;
  }
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.filePath === 'string') return input.filePath;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.pattern === 'string') return input.pattern;
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function formatTimeoutSuffixSeconds(timeoutMs: number): string {
  const secs = Math.round(timeoutMs / 1000);
  return ` (>${secs}s)`;
}

/**
 * Check whether the loaded rules contain a matching allow rule for this tool
 * call AND that no higher-priority deny/ask rule overrides it.
 *
 * Used by the policy-deny override logic to respect user-persisted
 * "Always allow" decisions for tools like web_fetch whose content-specific
 * rules (e.g. `web_fetch(*)`) are not resolved by the PermissionEngine's
 * whole-tool rule check (step 2b in the engine).
 *
 * Priority mirrors `LocalPermissionRuleStore.selectMatchingRule`:
 *   deny > ask > allow
 * Only returns true when the winning matched rule is an allow.
 */
function hasMatchingLocalAllowRule(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  return selectMatchingRule(rules, toolName, input)?.ruleBehavior === 'allow';
}

// `statSync` is used by the `isFile` probe above; this reference is a no-op
// guard kept for the reserved filesystem-touch validation helper.
void statSync;
