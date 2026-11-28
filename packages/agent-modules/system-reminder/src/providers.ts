/**
 * System-reminder providers — individual reminder block providers.
 *
 * Each provider is a ReminderProviderFn: it receives SystemReminderInput and
 * returns a string block for injection into <system-reminder>, or undefined
 * to skip. Providers are registered on a SystemReminderRegistry and executed
 * in registration order.
 *
 * The createDefaultRegistry() factory returns a registry pre-loaded with all
 * built-in providers. Framework-specific providers can be appended via
 * registry.appendFor() after creation.
 */

import type { ReminderPolicyEntry, ReminderProviderFn, SystemReminderInput } from './types.js';
import { boundMap } from './evolution.js';
import {
  buildAgentContextBlock,
  buildSlimAgentContextBlock,
  buildPeersUpdateBlock,
  buildCliSunsetMemoryNoticeBlock,
  buildMemorySkillReminder,
  buildProactiveMemoryBlock,
  buildMemoryTopicsBlock,
  buildPersonaMissingBlock,
  buildBootstrapBlock,
  buildTeamMemoryBlock,
  buildEvolutionReminderBlock,
  buildRelevantMemoryBlock,
  buildUserMemoryUpdateBlock,
  buildAgentMemoryUpdateBlock,
  buildMemorySummaryUpdateBlock,
  buildDailyMemoryUpdateBlock,
  buildIdentityUpdateBlock,
  buildConfigUpdateBlock,
  buildInboundMetaBlock,
  buildActivePlanReminderBlock,
  buildSkillEvolutionChannelsBlock,
  buildAsyncAuditBlock,
  buildMediaOutputReminderBlock,
  buildTaskCompletionReminderBlock,
  buildBoardNudgeBlock,
  buildWorktreeReminderBlock,
  buildSecretEnvBlock,
} from './blocks.js';
import { SystemReminderRegistry } from './registry.js';
import type { NudgeRegistry, DateFormatter } from './dependencies.js';
import { shouldInjectTodoCompletionReminder } from './todo-state.js';

// ─── Threshold Constants ─────────────────────────────────────────────────────

/** Cool-down between repeated cold-start reminder injections (per session+kind). */
export const COLD_START_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

// ─── ReminderPolicyEntry allowlist / policy helpers ──────────────────────────
//
// Cloud-runtime path: `AgentConfig.system_reminders` (IDL field 19) flows
// through `CloudDataCollector.collect()` into `SystemReminderInput.systemReminders`
// as a strict allowlist + per-entry policy override.
//
// Provider naming convention: registry registers providers as `xxxProvider`
// (e.g. `memorySkillReminderProvider`); Apollo `reminder_name` writes them
// without the `Provider` suffix (`memorySkillReminder`). `stripProviderSuffix`
// is the single normalisation point — service.ts uses it for allowlist
// filtering, each backoff provider uses it via `findReminderPolicy` to look
// up its own policy entry.

/** Drop the canonical `Provider` suffix when comparing registry name to Apollo `reminder_name`. */
export function stripProviderSuffix(name: string): string {
  return name.endsWith('Provider') ? name.slice(0, -'Provider'.length) : name;
}

/**
 * Look up the ReminderPolicyEntry that targets `providerName` in the per-turn
 * allowlist. Returns undefined when:
 *   - `input.systemReminders` is undefined (daemon path / legacy caller — no
 *     override, provider falls back to its hard-coded default schedule)
 *   - `input.systemReminders` is an empty array (cloud strict-off — provider
 *     won't fire because service.ts allowlist filter drops it; defensive
 *     lookup still returns undefined here)
 *   - no entry matches the stripped name
 *
 * The provider should read `.frequency` / `.thresholds` off the returned entry
 * and treat undefined fields as "use default".
 */
export function findReminderPolicy(
  input: SystemReminderInput,
  providerName: string,
): ReminderPolicyEntry | undefined {
  if (!input.systemReminders) return undefined;
  const key = stripProviderSuffix(providerName);
  return input.systemReminders.find((e) => e.name === key);
}

/**
 * Resolve the next backoff interval given a level (0-based emit count) and an
 * optional Apollo override sequence. Falls back to `defaultIntervals` when the
 * override is missing or empty. Both arrays clamp to the last value once
 * `level` exceeds their length — matches the daemon "cap at last interval"
 * behaviour used by every backoff provider.
 *
 * `override` may be `(number | string)[]` because wire protocol emits i64-capable
 * fields as `number | string`; SystemReminderFrequency.intervals is i32 so this
 * shows up as `number[]`. We accept both for forward-compat with any future
 * widening.
 */
export function effectiveInterval(
  level: number,
  override: ReadonlyArray<number | string> | undefined,
  defaultIntervals: readonly number[],
): number {
  const src = override && override.length > 0 ? override : defaultIntervals;
  // src.length > 0 guaranteed: override branch checked; defaultIntervals branch
  // is statically non-empty at every call site (ASYNC_AUDIT_DEFAULTS / etc).
  // tsconfig has noUncheckedIndexedAccess so widen via nullish-coalesce + last-elem fallback.
  const idx = Math.min(level, src.length - 1);
  const raw = src[idx] ?? src[src.length - 1] ?? 0;
  return typeof raw === 'string' ? Number(raw) : raw;
}

/** Resolve a single i32 ms override (number|string) with a fallback. */
export function effectiveMs(override: number | string | undefined, fallback: number): number {
  if (override === undefined || override === null) return fallback;
  return typeof override === 'string' ? Number(override) : override;
}

/**
 * Normalise an optional i32 ms override (wire protocol emits `number | string`)
 * into `number | undefined`. Used by cold-start cooldown providers that pass
 * the result straight into `tryEnterColdStart`'s `cooldownOverrideMs` slot
 * (undefined → fall back to per-kind default).
 */
export function effectiveMsOr(override: number | string | undefined): number | undefined {
  if (override === undefined || override === null) return undefined;
  return typeof override === 'string' ? Number(override) : override;
}

// ─── Cold-start cool-down state ──────────────────────────────────────────────
//
// Cold-start reminders (persona_missing, bootstrap_check) are
// noisy if injected on every turn. We track per-session+per-kind last-injected timestamps
// in process memory. State is intentionally non-persistent — daemon restart resets it,
// which is acceptable: a single re-injection right after restart is harmless.
//
// Tests can call `_resetColdStartCooldownForTests()` to clear state between cases.

type ColdStartKind = 'persona_missing' | 'bootstrap_check' | 'worktree_check';
const coldStartLastInjectedAt = new Map<string, number>();

/** Cool-down key — sessionId+kind, falls back to agentName when env is unavailable. */
function coldStartKey(input: SystemReminderInput, kind: ColdStartKind): string {
  const id = input.env?.sessionId ?? input.env?.agentName ?? 'unknown';
  return `${id}::${kind}`;
}

/**
 * Check whether a cold-start reminder is allowed to fire now.
 * Records the timestamp on success; subsequent calls within the cool-down window return false.
 *
 * `cooldownOverrideMs` (typically `thresholds.cooldown_ms` from the package-local
 * ReminderPolicyEntry) takes precedence over `COLD_START_COOLDOWN_MS`.
 *
 * `now` is overridable for deterministic tests.
 */
function tryEnterColdStart(
  input: SystemReminderInput,
  kind: ColdStartKind,
  cooldownOverrideMs: number | undefined,
  now: number = Date.now(),
): boolean {
  const key = coldStartKey(input, kind);
  const last = coldStartLastInjectedAt.get(key);
  const cooldown = cooldownOverrideMs ?? COLD_START_COOLDOWN_MS;
  if (last !== undefined && now - last < cooldown) return false;
  coldStartLastInjectedAt.set(key, now);
  return true;
}

/** Test helper — clear cool-down state. Not exported from the package public API. */
export function _resetColdStartCooldownForTests(): void {
  coldStartLastInjectedAt.clear();
}

/** Cold-start reminders only fire for orchestrators or manually-created agents. */
function isColdStartAudience(input: SystemReminderInput): boolean {
  if (input.env?.agentRole === 'orchestrator') return true;
  if (input.creationSource === 'manual') return true;
  return false;
}

// ─── Individual Providers ────────────────────────────────────────────────────

/** Inject <agent-context> block with session/agent metadata. */
export const agentContextProvider: ReminderProviderFn = (input) => {
  if (!input.env) return undefined;
  if (input.turnCount !== undefined && input.turnCount > 1) {
    return buildSlimAgentContextBlock(input.env);
  }
  return buildAgentContextBlock(input.env, { teamModeOff: input.teamModeOff });
};

/** Inject <peers_update> when peer list changes mid-session. */
export const peersUpdateProvider: ReminderProviderFn = (input) => {
  if (input.teamModeOff) return undefined;
  if (!input.peersChanged || !input.env?.peers?.length) return undefined;
  return buildPeersUpdateBlock(input.env.peers);
};

/**
 * Inject <active-plan-reminder> for orchestrators who own one or more active
 * team plans. Worker sessions and sessions with no active plans are skipped.
 * Reminds the orchestrator to keep new requirement changes inside the
 * existing plan via `mavis team plan pause` + `decision` rather than
 * spawning standalone sessions.
 */
export const activePlanReminderProvider: ReminderProviderFn = (input) => {
  if (input.teamModeOff) return undefined;
  if (input.env?.agentRole !== 'orchestrator') return undefined;
  if (!input.activePlans?.length) return undefined;
  return buildActivePlanReminderBlock(input.activePlans);
};

/** Inject <memory-skill-reminder> with file size, skill-evolution routing trigger,
 * and the three-question memory-layer attribution.
 *
 * Schedule: turn 1, then 10 → 20 → 40 → 40... turns apart (cap at 40).
 * Resets on compaction (turnCount drops below lastInjectedAt).
 *
 * Renamed from `memoryStatusProvider` — the block now teaches a precondition
 * before the memory-layer test: "is this a SKILL signal/proposal instead?"
 * The skill section gates independently per channel via
 * `input.skillEvolveEnabled` (signal) and `input.skillProposalEnabled`
 * (proposal); when both are off, only the three-question memory-layer test
 * is rendered. The full skill-evolution channel rules live in the
 * `skill-evolution` skill; this block carries only the trigger checklist
 * + skill names so agents in long sessions stop silently defaulting to
 * `mavis memory append`.
 */
export const memorySkillReminderProvider: ReminderProviderFn = (input) => {
  if (!input.env) return undefined;
  const skillOpts = {
    skillEvolveEnabled: input.skillEvolveEnabled === true,
    skillProposalEnabled: input.skillProposalEnabled === true,
  };
  const turn = input.turnCount ?? 0;
  if (turn < 1) {
    // Fallback for callers that do not pass turnCount — preserve original
    // "always inject" behavior so SR rendering paths without turn info
    // still get the block.
    const block = buildMemorySkillReminder(input.memorySkillReminder, {
      ...skillOpts,
      scene: input.env.scene,
      dataDir: input.env.dataDir,
    });
    return block || undefined;
  }

  const sessionId = input.env.sessionId ?? 'unknown';
  const state = memorySkillReminderState.get(sessionId);
  const policy = findReminderPolicy(input, 'memorySkillReminderProvider');
  const overrideIntervals = policy?.frequency?.intervals;

  // First turn or no state → inject and initialize
  if (turn <= 1 || !state) {
    memorySkillReminderState.set(sessionId, { lastInjectedAt: turn, backoffLevel: 0 });
    boundMap(memorySkillReminderState);
    const block = buildMemorySkillReminder(input.memorySkillReminder, {
      ...skillOpts,
      scene: input.env.scene,
      dataDir: input.env.dataDir,
    });
    return block || undefined;
  }

  // Compaction detected: turnCount dropped below last injection point → reset
  if (turn < state.lastInjectedAt) {
    memorySkillReminderState.set(sessionId, { lastInjectedAt: turn, backoffLevel: 0 });
    boundMap(memorySkillReminderState);
    const block = buildMemorySkillReminder(input.memorySkillReminder, {
      ...skillOpts,
      scene: input.env.scene,
      dataDir: input.env.dataDir,
    });
    return block || undefined;
  }

  const interval = effectiveInterval(
    state.backoffLevel,
    overrideIntervals,
    MEMORY_SKILL_REMINDER_DEFAULTS,
  );
  if (turn - state.lastInjectedAt >= interval) {
    memorySkillReminderState.set(sessionId, {
      lastInjectedAt: turn,
      backoffLevel: state.backoffLevel + 1,
    });
    boundMap(memorySkillReminderState);
    const block = buildMemorySkillReminder(input.memorySkillReminder, {
      ...skillOpts,
      scene: input.env.scene,
      dataDir: input.env.dataDir,
    });
    return block || undefined;
  }

  return undefined;
};

/** Inject the opt-in proactive-memory rubric on every eligible turn. */
export const proactiveMemoryProvider: ReminderProviderFn = (input) => {
  if (input.proactiveMemoryEnabled !== true) return undefined;
  return buildProactiveMemoryBlock();
};

interface MemorySkillReminderState {
  lastInjectedAt: number;
  backoffLevel: number;
}

const memorySkillReminderState = new Map<string, MemorySkillReminderState>();

/** Default backoff schedule: 10, 20, 40 (cap). Apollo `intervals` overrides this. */
const MEMORY_SKILL_REMINDER_DEFAULTS = [10, 20, 40] as const;

/**
 * @deprecated Use `effectiveInterval(level, override, MEMORY_SKILL_REMINDER_DEFAULTS)`.
 * Kept temporarily for any external import; the inline impl matches the old
 * 10 / 20 / 40 (cap) ladder.
 */
function memorySkillReminderInterval(level: number): number {
  return effectiveInterval(level, undefined, MEMORY_SKILL_REMINDER_DEFAULTS);
}
// Suppress lint warning — kept on purpose for back-compat (see deprecation note above).
void memorySkillReminderInterval;

/** Test helper — clear memory-skill-reminder backoff state. */
export function _resetMemorySkillReminderStateForTests(): void {
  memorySkillReminderState.clear();
}

/** Inject <available_memory_topics> listing topic files with descriptions. */
export const memoryTopicsProvider: ReminderProviderFn = (input) => {
  if (!input.env) return undefined;
  // Only inject on first message (topics don't change mid-session)
  if (input.turnCount !== undefined && input.turnCount !== 1) return undefined;
  const block = buildMemoryTopicsBlock(input.memoryTopics);
  return block || undefined;
};

/**
 * Inject <cli-sunset-memory-notice> when the host flagged stored memory files
 * as predating the mavis CLI removal. First turn only — the host re-evaluates
 * per session (and after compaction resets turnCount), so eligibility stays
 * fresh without provider-side state.
 */
export const cliSunsetMemoryNoticeProvider: ReminderProviderFn = (input) => {
  if (input.turnCount !== undefined && input.turnCount !== 1) return undefined;
  const block = buildCliSunsetMemoryNoticeBlock(input.cliSunsetMemoryNotice);
  return block || undefined;
};

/**
 * Inject <persona_missing> for cold-start audiences when the agent has no real persona yet.
 * Cool-down: 6h default per (session, kind); Apollo `thresholds.cooldown_ms` overrides.
 */
export const personaMissingProvider: ReminderProviderFn = (input) => {
  if (!input.personaMissing) return undefined;
  if (!isColdStartAudience(input)) return undefined;
  const policy = findReminderPolicy(input, 'personaMissingProvider');
  const cooldownMs = policy?.thresholds?.cooldown_ms;
  if (!tryEnterColdStart(input, 'persona_missing', effectiveMsOr(cooldownMs))) return undefined;
  const personaPath = input.personaPath ?? '<unknown>';
  const agentName = input.env?.agentName ?? '<agent>';
  return buildPersonaMissingBlock(personaPath, agentName, { scene: input.env?.scene });
};

/**
 * Create a <branch-finish-alert> provider that renders finish timestamps using
 * the host-injected local-date formatter (the host owns the timezone).
 */
export function createBranchNotificationProvider(
  formatLocalDateTime: DateFormatter,
): ReminderProviderFn {
  return (input) => {
    if (!input.branchNotifications?.length) return undefined;
    const lines = input.branchNotifications.map(
      (n) =>
        `- "${n.title ?? '(untitled)'}" (${n.branchSessionId}) finished at ${formatLocalDateTime(n.finishedAt)} without sending a report.` +
        ` Use \`mavis session messages ${n.branchSessionId}\` to check its results.`,
    );
    return (
      `<branch-finish-alert>\n` +
      `The following branch sessions finished without reporting back to you:\n` +
      `${lines.join('\n')}\n` +
      `Review their results and take action if needed.\n` +
      `</branch-finish-alert>`
    );
  };
}

/**
 * Inject session-scoped one-shot reminder bodies (e.g. session-rotate
 * handoff bootstrap, async handoff-ready notice). Each entry is already a
 * complete block — the outer `<system-reminder>` wrapper is added by
 * SystemReminderService. Multiple entries are joined with a blank line.
 *
 * Consumed by SystemReminderDataCollector — entries are cleared on
 * collect, so each reminder is delivered exactly once.
 */
export const pendingSessionRemindersProvider: ReminderProviderFn = (input) => {
  if (!input.pendingSessionReminders?.length) return undefined;
  return input.pendingSessionReminders
    .map((c) => c.trim())
    .filter(Boolean)
    .join('\n\n');
};

/** Remind agents to reconcile active TodoWrite items before final delivery. */
export const taskCompletionReminderProvider: ReminderProviderFn = (input) => {
  const sessionId = input.env?.sessionId;
  const turn = input.turnCount ?? 0;
  if (!input.activeTodoState) return undefined;
  if (!sessionId || turn < 1) return undefined;

  const policy = findReminderPolicy(input, 'taskCompletionReminderProvider');
  const intervalTurns = effectiveMs(policy?.thresholds?.todo_reminder_interval_turns, 5);
  const summary = shouldInjectTodoCompletionReminder(sessionId, turn, intervalTurns);
  if (!summary) return undefined;
  return buildTaskCompletionReminderBlock(summary);
};

/** Inject evolution reminder (memory-write reminder only). */
export const evolutionReminderProvider: ReminderProviderFn = (input) => {
  if (!input.evolutionReminder?.trim()) return undefined;
  return buildEvolutionReminderBlock(input.evolutionReminder.trim());
};

/**
 * Inject <bootstrap_check> for cold-start audiences in uninitialized workspaces.
 * Cool-down: 6h default per (session, kind); Apollo `thresholds.cooldown_ms` overrides.
 */
export const bootstrapProvider: ReminderProviderFn = (input) => {
  if (!input.needsBootstrap) return undefined;
  if (!input.isGitWorkspace) return undefined; // non-git workspaces don't need AGENTS.md bootstrap
  if (!isColdStartAudience(input)) return undefined;
  const policy = findReminderPolicy(input, 'bootstrapProvider');
  const cooldownMs = policy?.thresholds?.cooldown_ms;
  if (!tryEnterColdStart(input, 'bootstrap_check', effectiveMsOr(cooldownMs))) return undefined;
  return buildBootstrapBlock(input.workspaceDir, { scene: input.env?.scene });
};

/**
 * Inject <worktree-reminder> for cloud and legacy callers in a git checkout.
 *
 * Audience: ALL agents (orchestrator, worker, branch — any role can edit code).
 * Local-runtime resolves explicit UI worktree selection before the turn. This
 * reminder prevents cloud and legacy callers from creating duplicate worktrees
 * while leaving the final branch policy to the repository instructions.
 * Suppression: skipped when the agent is already inside a worktree
 * (`.git` is a gitlink file rather than a directory) — at that point the
 * worktree workflow is presumed in effect.
 *
 * Cool-down: 6h default per (session, kind); Apollo `thresholds.cooldown_ms` overrides.
 * Rationale: the rule is short and stable; once-per-session is enough.
 * 6h handles long-lived sessions and post-rotation re-injection without
 * spamming context on every turn.
 */
export const worktreeReminderProvider: ReminderProviderFn = (input) => {
  if (input.env?.scene === 'local') return undefined;
  if (!input.isGitWorkspace) return undefined;
  if (input.isInsideWorktree) return undefined;
  const policy = findReminderPolicy(input, 'worktreeReminderProvider');
  const cooldownMs = policy?.thresholds?.cooldown_ms;
  if (!tryEnterColdStart(input, 'worktree_check', effectiveMsOr(cooldownMs))) return undefined;
  return buildWorktreeReminderBlock();
};

/** Inject <team_memory> with sibling agent memory headings. */
export const teamMemoryProvider: ReminderProviderFn = (input) => {
  if (!input.teamMemoryIndex?.trim()) return undefined;
  return buildTeamMemoryBlock(input.teamMemoryIndex.trim());
};

/** Inject <relevant-memory> with query-matched memory sections. */
export const relevantMemoryProvider: ReminderProviderFn = (input) => {
  if (!input.relevantMemory?.trim()) return undefined;
  return buildRelevantMemoryBlock(input.relevantMemory.trim());
};

/** Inject <user_memory_update> when user memory changes mid-session. */
export const userMemoryUpdateProvider: ReminderProviderFn = (input) => {
  if (!input.userMemoryUpdate?.trim()) return undefined;
  return buildUserMemoryUpdateBlock(input.userMemoryUpdate.trim());
};

/** Inject <agent_memory_update> when agent MEMORY.md changes mid-session. */
export const agentMemoryUpdateProvider: ReminderProviderFn = (input) => {
  if (!input.agentMemoryUpdate?.trim()) return undefined;
  return buildAgentMemoryUpdateBlock(input.agentMemoryUpdate.trim());
};

/** Inject <memory_summary_update> when .summary.md is regenerated mid-session. */
export const memorySummaryUpdateProvider: ReminderProviderFn = (input) => {
  if (!input.memorySummaryUpdate?.trim()) return undefined;
  return buildMemorySummaryUpdateBlock(input.memorySummaryUpdate.trim());
};

/** Inject <daily_memory_update> when daily digest changes mid-session. */
export const dailyMemoryUpdateProvider: ReminderProviderFn = (input) => {
  if (!input.dailyMemoryUpdate?.trim()) return undefined;
  return buildDailyMemoryUpdateBlock(input.dailyMemoryUpdate.trim());
};

/** Inject <identity_update> when identity changes mid-session. */
export const identityUpdateProvider: ReminderProviderFn = (input) => {
  if (!input.identityUpdate?.display_name) return undefined;
  return buildIdentityUpdateBlock(input.identityUpdate);
};

/** Inject <config_update> when agent config files change mid-session. */
export const configUpdateProvider: ReminderProviderFn = (input) => {
  if (!input.configUpdate) return undefined;
  return buildConfigUpdateBlock();
};

/** Inject inbound message metadata block. */
export const inboundMetaProvider: ReminderProviderFn = (input) => {
  if (!input.inboundMeta || Object.keys(input.inboundMeta).length === 0) return undefined;
  return buildInboundMetaBlock(input.inboundMeta);
};

/** Inject <skill-evolution-channels> teaching block when skill-evolve is enabled.
 * Only on the first message — agents don't need re-teaching every turn.
 * Excluded agents (e.g. skill-editor) never see this block.
 *
 * The proposal section inside the block is independently gated by
 * `input.skillProposalEnabled` — when proposal is off, only the Signal
 * section is rendered (parent gate `skillEvolveEnabled` still on).
 */
export const skillEvolutionChannelsProvider: ReminderProviderFn = (input) => {
  if (input.turnCount !== undefined && input.turnCount !== 1) return undefined; // first message only
  if (!input.skillEvolveEnabled) return undefined;
  return buildSkillEvolutionChannelsBlock({
    skillProposalEnabled: input.skillProposalEnabled === true,
  });
};

/**
 * @deprecated Renamed to `skillEvolutionChannelsProvider` in v3. The export
 * is retained as an alias so external imports keep compiling during the
 * rename window — remove in a follow-up cleanup.
 */
export const skillSignalReportingProvider = skillEvolutionChannelsProvider;

// teamModeProvider — removed: team-mode hint is now injected directly into system_prompt
// via transformSystemPrompt() in the legacy local-runtime plugin for better reliability.

// ─── Async Audit Provider ────────────────────────────────────────────────────
//
// Periodically reminds agents to check for unmonitored async operations.
//
// Schedule: inject on turn 1, then every N turns with exponential backoff:
//   5 → 10 → 20 → 20 → 20... (cap at 20)
//
// Reset triggers:
//   - Compaction: turnCount drops below lastInjectedAt → reset + inject
//   - New session (no state yet) → inject on first turn
//
// State is in-process memory, keyed by sessionId. Non-persistent intentionally.

interface AsyncAuditState {
  lastInjectedAt: number;
  backoffLevel: number;
}

const asyncAuditState = new Map<string, AsyncAuditState>();

/** Default backoff schedule: 5, 10, 20 (cap). Apollo `intervals` overrides this. */
const ASYNC_AUDIT_DEFAULTS = [5, 10, 20] as const;

/** Test helper — clear async audit state. */
export function _resetAsyncAuditStateForTests(): void {
  asyncAuditState.clear();
}

/**
 * Inject <async-audit> reminder on a turn-based schedule with exponential backoff.
 *
 * - Always fires on turn 1 (session start)
 * - Then every 5 → 10 → 20 → 20... turns (default; Apollo `intervals` overrides)
 * - Resets when turnCount drops (compaction detected)
 * - Silent when the current host or Agent disables Cron.
 */
export const asyncAuditProvider: ReminderProviderFn = (input) => {
  if (input.mavisEnabled === false) return undefined;
  if (input.cronEnabled === false) return undefined;
  const turn = input.turnCount ?? 0;
  if (turn < 1) return undefined;

  const sessionId = input.env?.sessionId ?? 'unknown';
  const state = asyncAuditState.get(sessionId);
  const policy = findReminderPolicy(input, 'asyncAuditProvider');
  const overrideIntervals = policy?.frequency?.intervals;

  // First turn or no state → inject and initialize
  if (turn <= 1 || !state) {
    asyncAuditState.set(sessionId, { lastInjectedAt: turn, backoffLevel: 0 });
    return buildAsyncAuditBlock();
  }

  // Compaction detected: turnCount dropped below last injection point → reset
  if (turn < state.lastInjectedAt) {
    asyncAuditState.set(sessionId, { lastInjectedAt: turn, backoffLevel: 0 });
    return buildAsyncAuditBlock();
  }

  // Check if enough turns have elapsed for the next injection
  const interval = effectiveInterval(state.backoffLevel, overrideIntervals, ASYNC_AUDIT_DEFAULTS);
  if (turn - state.lastInjectedAt >= interval) {
    asyncAuditState.set(sessionId, {
      lastInjectedAt: turn,
      backoffLevel: state.backoffLevel + 1,
    });
    return buildAsyncAuditBlock();
  }

  return undefined;
};

// ─── Media Output Reminder Provider ──────────────────────────────────────────
//
// Periodically reminds agents to deliver files using the current surface's
// system-prompt protocol and verify their current state.
//
// Schedule: inject on turn 1, then every N turns with exponential backoff:
//   10 → 20 → 40 → 40 → 40... (cap at 40)
//
// Audience: orchestrator or manually-created agents only — workers don't
// send deliverables directly to the user.

interface MediaOutputState {
  lastInjectedAt: number;
  backoffLevel: number;
}

const mediaOutputState = new Map<string, MediaOutputState>();

/** Default backoff schedule: 10, 20, 40 (cap). Apollo `intervals` overrides this. */
const MEDIA_OUTPUT_DEFAULTS = [10, 20, 40] as const;

/** Test helper — clear media output state. */
export function _resetMediaOutputStateForTests(): void {
  mediaOutputState.clear();
}

/**
 * Inject <media-output-reminder> on a turn-based schedule with exponential backoff.
 *
 * - Always fires on turn 1 (session start)
 * - Then every 10 → 20 → 40 → 40... turns (default; Apollo `intervals` overrides)
 * - Resets when turnCount drops (compaction detected)
 * - Only for orchestrators or manually-created agents
 */
export const mediaOutputReminderProvider: ReminderProviderFn = (input) => {
  const turn = input.turnCount ?? 0;
  if (turn < 1) return undefined;

  // Only for orchestrator or manual agents — workers don't send deliverables to users
  if (input.env?.agentRole !== 'orchestrator' && input.creationSource !== 'manual') {
    return undefined;
  }

  const sessionId = input.env?.sessionId ?? 'unknown';
  const state = mediaOutputState.get(sessionId);
  const policy = findReminderPolicy(input, 'mediaOutputReminderProvider');
  const overrideIntervals = policy?.frequency?.intervals;

  // First turn or no state → inject and initialize
  if (turn <= 1 || !state) {
    mediaOutputState.set(sessionId, { lastInjectedAt: turn, backoffLevel: 0 });
    return buildMediaOutputReminderBlock({ scene: input.env?.scene });
  }

  // Compaction detected: turnCount dropped below last injection point → reset
  if (turn < state.lastInjectedAt) {
    mediaOutputState.set(sessionId, { lastInjectedAt: turn, backoffLevel: 0 });
    return buildMediaOutputReminderBlock({ scene: input.env?.scene });
  }

  // Check if enough turns have elapsed for the next injection
  const interval = effectiveInterval(state.backoffLevel, overrideIntervals, MEDIA_OUTPUT_DEFAULTS);
  if (turn - state.lastInjectedAt >= interval) {
    mediaOutputState.set(sessionId, {
      lastInjectedAt: turn,
      backoffLevel: state.backoffLevel + 1,
    });
    return buildMediaOutputReminderBlock({ scene: input.env?.scene });
  }

  return undefined;
};

// ─── Secret Env Reminder Provider ────────────────────────────────────────────
//
// Tells the agent which encrypted secret env var names are available this
// turn (e.g. `OPENAI_API_KEY`). The values themselves are never surfaced —
// they're resolved at shell-command time by the cloud-runtime export prefix
// and masked on outbound text by SecretMasker.
//
// Schedule: emit on turn 1 (cold start) and whenever the sorted name set
// has changed since the last emission for this session. Steady-state turns
// stay silent so we don't reprint the same list every turn.
//
// State: per-session djb2 hash of the sorted name list, kept in process
// memory. Non-persistent — mirrors the rest of this module. Resets when a
// session is removed (collector takes care of that for memoryDeltaTracker
// etc.; this state map relies on the cooldown/hash table never growing
// without bound because it's keyed by the same finite session set).
//
// Empty store → return undefined (no point reminding the agent about
// nothing). Source data must be a NAME LIST ONLY — the caller MUST NOT pass
// secret values into `SystemReminderInput.secretNames`.

interface SecretEnvReminderState {
  /** djb2 hash of the sorted name list at last injection. */
  hash: number;
}

const secretEnvReminderState = new Map<string, SecretEnvReminderState>();

/** djb2 hash — same primitive the cloud-runtime peer-change detector uses. */
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** Test helper — clear secret-env-reminder state across all sessions. */
export function _resetSecretEnvReminderStateForTests(): void {
  secretEnvReminderState.clear();
}

/**
 * Inject <secret-env> on turn 1 and whenever the secret name set changes
 * mid-session. Stays silent when:
 *   - `secretNames` is undefined (daemon / legacy path with no SecretStore wiring)
 *   - `secretNames` is empty (cloud store wired but no secrets configured)
 *   - The sorted name set is identical to the last emission for this session
 *     AND we're not on turn 1
 *
 * Names are sorted before hashing AND before rendering — same sort order
 * keeps the block visually stable across turns and the hash deterministic
 * regardless of the input order the host happens to supply.
 */
export const secretEnvReminderProvider: ReminderProviderFn = (input) => {
  if (input.secretNames === undefined) return undefined;
  if (input.secretNames.length === 0) return undefined;

  const sessionId = input.env?.sessionId ?? 'unknown';
  const sorted = [...input.secretNames].sort();
  const hash = djb2Hash(sorted.join('|'));
  const state = secretEnvReminderState.get(sessionId);
  const turn = input.turnCount ?? 0;
  const firstTurn = turn <= 1 || !state;
  const namesChanged = !!state && state.hash !== hash;

  if (!firstTurn && !namesChanged) return undefined;

  secretEnvReminderState.set(sessionId, { hash });
  boundMap(secretEnvReminderState);
  return buildSecretEnvBlock(sorted);
};

// ─── Board Nudge Provider (closure-based) ────────────────────────────────────
//
// Created by the container and appended to the registry after construction.
// Captures a NudgeRegistry reference so it can read pending nudge flags set
// by BoardWatcher without adding a new field to SystemReminderInput.
//
// Flow:
//   1. BoardWatcher sets a nudge flag in the registry
//   2. On the worker's next tool-result turn, this provider reads and clears it
//   3. The <engine-nudge> block appears inside <system-reminder>
//   4. The agent sees it and (hopefully) updates the board

/**
 * Create a board-nudge provider that reads from the given NudgeRegistry.
 * The provider injects an <engine-nudge> block when a session has a pending nudge,
 * then clears the flag so the agent sees it exactly once per nudge cycle.
 */
export function createBoardNudgeProvider(nudgeRegistry: NudgeRegistry): ReminderProviderFn {
  return (input: SystemReminderInput) => {
    if (!input.env?.sessionId) return undefined;
    const nudge = nudgeRegistry.get(input.env.sessionId);
    if (!nudge) return undefined;
    // Clear after injection — one-shot delivery per nudge cycle.
    // If the agent still doesn't update the board, BoardWatcher will set
    // another nudge on the next poll.
    nudgeRegistry.clear(input.env.sessionId);
    return buildBoardNudgeBlock(nudge.boardPath);
  };
}

// ─── Default Registry Factory ────────────────────────────────────────────────

/**
 * Create a SystemReminderRegistry pre-loaded with all default providers.
 *
 * The default set is framework-agnostic — every provider runs for all framework
 * types. Use `registry.appendFor(frameworkType, fn)` after creation to add
 * framework-specific providers.
 *
 * Provider execution order matches the block order in <system-reminder>.
 *
 * @param formatLocalDateTime host-injected local-date formatter (the host owns
 *   the timezone) used by the branch-finish-alert provider.
 */
export function createDefaultRegistry(formatLocalDateTime: DateFormatter): SystemReminderRegistry {
  return (
    new SystemReminderRegistry()
      .append('agentContextProvider', agentContextProvider)
      .append('peersUpdateProvider', peersUpdateProvider)
      .append('activePlanReminderProvider', activePlanReminderProvider)
      .append('memorySkillReminderProvider', memorySkillReminderProvider)
      .append('proactiveMemoryProvider', proactiveMemoryProvider)
      .append('memoryTopicsProvider', memoryTopicsProvider)
      .append('cliSunsetMemoryNoticeProvider', cliSunsetMemoryNoticeProvider)
      .append('personaMissingProvider', personaMissingProvider)
      .append('branchNotificationProvider', createBranchNotificationProvider(formatLocalDateTime))
      .appendCritical('pendingSessionRemindersProvider', pendingSessionRemindersProvider)
      .appendCritical('taskCompletionReminderProvider', taskCompletionReminderProvider)
      .append('evolutionReminderProvider', evolutionReminderProvider)
      .append('bootstrapProvider', bootstrapProvider)
      .append('worktreeReminderProvider', worktreeReminderProvider)
      .append('teamMemoryProvider', teamMemoryProvider)
      // relevantMemoryProvider removed — low relevance precision wastes ~500-1000 tokens/turn
      .append('userMemoryUpdateProvider', userMemoryUpdateProvider)
      .append('agentMemoryUpdateProvider', agentMemoryUpdateProvider)
      .append('memorySummaryUpdateProvider', memorySummaryUpdateProvider)
      .append('dailyMemoryUpdateProvider', dailyMemoryUpdateProvider)
      .append('identityUpdateProvider', identityUpdateProvider)
      .append('configUpdateProvider', configUpdateProvider)
      .append('inboundMetaProvider', inboundMetaProvider)
      .append('skillEvolutionChannelsProvider', skillEvolutionChannelsProvider)
      .appendCritical('mediaOutputReminderProvider', mediaOutputReminderProvider)
      .appendCritical('asyncAuditProvider', asyncAuditProvider)
      .append('secretEnvReminderProvider', secretEnvReminderProvider)
  );
}
