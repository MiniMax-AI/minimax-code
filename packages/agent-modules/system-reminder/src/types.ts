/**
 * System-reminder types — shared across all framework adapters.
 *
 * Migrated from legacy prompt transform to enable
 * framework-agnostic system-reminder injection at the SessionBridge level.
 *
 * Configuration is keyed by AgentFrameworkType so each framework can have
 * independent reminder schedules (e.g. "first message only" vs "every 5 messages").
 */

// ─── Session / Message contracts (self-owned) ────────────────────────────────
//
// These enums and the narrow SessionInfo / MessageRequest shapes are owned by
// this package. They were originally defined here, briefly lived under the
// agent-core host layer, and are kept self-contained again so system-reminder
// never imports a runtime host package. The agent-core host layer keeps its
// own independent copies for its orchestration consumers; the two are
// deliberately decoupled (structural compatibility is all the cloud shim
// needs).

/**
 * Session role in the agent's session tree.
 *
 * - Branch: a task-scoped child session (has a parent).
 * - Root:   the long-lived front-door session for the agent.
 *
 * Numeric values are stable forever (persisted in `sessions.session_type`).
 */
export enum SessionType {
  Branch = 0,
  Root = 1,
}

/**
 * Channel role for messages flowing through the runtime — the user-vs-agent
 * distinction. Distinct from the protocol-level speaker role (`user`/`assistant`).
 */
export enum Role {
  User = "user",
  Agent = "agent",
}

/** Worker vs orchestrator agent classification. */
export enum AgentRole {
  Worker = 0,
  Orchestrator = 1,
}

/** Underlying agent framework. */
export enum AgentFrameworkType {
  /** @deprecated Legacy opencode sessions are only resumable through the legacy boundary. */
  OpenCode = "opencode",
  PiAgent = "pi-agent",
  Codex = "codex",
}

/**
 * Narrow service-level session info consumed by the system-reminder data
 * path. A structural subset of the host's session shape — only the fields
 * the SR service / collector / providers actually read, plus the timestamps
 * the cloud shim fills. Hosts satisfy this by structural compatibility (no
 * `implements` needed).
 */
export interface SessionInfo {
  sessionId: string;
  agentName: string;
  agentRole: AgentRole;
  sessionType: SessionType;
  frameworkType: AgentFrameworkType;
  workspaceDir?: string;
  /** Absolute path to the shared scratchpad file for this session tree. */
  scratchpadPath?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Narrow message request consumed by the system-reminder data path. The SR
 * service only reads `model`; `content` / `fromRole` / `turnId` are filled by
 * callers (e.g. the cloud shim) and carried for the data collector.
 */
export interface MessageRequest {
  content: string;
  fromRole: Role;
  /** Optional model override from the client. */
  model?: {
    providerID: string;
    modelID: string;
    variant?: string;
  };
  turnId?: string;
}

// ─── Provider Function Type ──────────────────────────────────────────────────

/**
 * A reminder provider function — the unit of the chain-of-responsibility pattern.
 *
 * Each provider receives the collected SystemReminderInput and returns a string
 * block for injection into <system-reminder>, or undefined to skip.
 *
 * Providers are registered on a SystemReminderRegistry and executed in order.
 * Different AgentFrameworkType can register different sets of providers.
 */
export type ReminderProviderFn = (
  input: SystemReminderInput,
) => string | undefined | Promise<string | undefined>;

// ─── Data Types (migrated from legacy local-runtime plugin/src/transform.ts) ─────────────

export interface PeerInfo {
  sessionId: string;
  agentName: string;
  agentRole: string;
  /** User-facing display name (from identity.display_name or config.displayName). */
  displayName?: string;
  /** Session title — a short summary set by the session owner. */
  title?: string;
  /** Session status — e.g. active, idle, closed. */
  status?: string;
}

export interface AgentEnv {
  /** The host supplies stable environment facts in the System Prompt. */
  environmentInSystemPrompt?: boolean | undefined;
  workspaceDir: string;
  /** Whether the workspace is the system default (true) or user-selected (false). */
  isDefaultWorkspace?: boolean | undefined;
  agentConfigDir: string;
  agentName: string;
  /** User-facing display name (from identity.display_name). Surfaces in <agent-context> as `agent: <displayName>`. */
  displayName?: string | undefined;
  /** User-configured name the model should use when addressing the user. */
  userConfiguredName?: string | undefined;
  agentRole: string;
  sessionId: string;
  /**
   * Host-verified fact that the model-visible context already carries
   * `YOUR SESSION ID` (e.g. an earlier user message since the latest
   * compaction). When true, the slim per-turn block omits the line to save
   * tokens. Absent/false keeps the line (cloud and legacy callers).
   */
  sessionIdInContext?: boolean | undefined;
  /** Session type — 0=Branch, 1=Root (formerly Main). */
  sessionType?: number | undefined;
  /** Parent session ID — set when this is a child session. */
  parentSessionId?: string | undefined;
  /** Host-trusted result delivery mode for local task children. */
  taskResultDelivery?: "runtime-managed" | undefined;
  /** Root session ID for this agent — used by Branch sessions to report back. */
  rootSessionId?: string | undefined;
  platform: string;
  /** User/system locale resolved by the host data collector (e.g. "zh-CN"). */
  systemLocale?: string | undefined;
  /** Trusted MiniMax deployment/account region used for regional product docs. */
  region?: "cn" | "en" | undefined;
  /**
   * Runtime scene the env was produced in.
   * - 'local' (default) — local runtime path.
   * - 'cloud'           — cloud-runtime path; activates cloud-tailored variants
   *   of <agent-context> (no `agentName:` line, no `IS_DEFAULT_WORKSPACE`, no
   *   `YOUR AGENT CONFIG DIRECTORY`).
   */
  scene?: "cloud" | "local" | undefined;
  date: string;
  /** Path to the project AGENTS.md instructions file relative to workspaceDir, if found. */
  projectInstructions?: string | undefined;
  /** Reachable peer sessions for inter-agent communication. */
  peers?: PeerInfo[] | undefined;
  /** Directory path this agent was imported from (e.g. /path/to/project/.agents/agent-name). */
  importedFrom?: string | undefined;
  /** Local runtime port this agent is connected to. */
  runtimePort?: number | undefined;
  /** Active profile name (e.g. "dev"), null when running the default profile. */
  profile?: string | null | undefined;
  /** Local runtime data directory (e.g. ~/.minimax-dev). */
  dataDir?: string | undefined;
  /**
   * Absolute path to the shared root-session scratchpad file. Inherited by
   * child sessions from their root, so both Main and Branch sessions see
   * the same path. Surfaces in `<agent-context>` as `YOUR SCRATCHPAD: ...`
   * and is also exported as `MAVIS_SCRATCHPAD` in the agent's shells.
   */
  scratchpadPath?: string | undefined;
  /** True when running from monorepo source (pnpm dev), false for npm bundle. */
  isMonorepoDev?: boolean | undefined;
  /**
   * Browser bridge availability snapshot for the agent's profile.
   * Present only when the Chrome extension's native host is currently connected.
   *
   * This belongs in `<agent-context>` rather than a one-shot reminder because
   * it is dynamic ambient state: the extension may connect/disconnect between
   * user messages, and the next user-message context should reflect that.
   */
  browserBridge?:
    | {
        profile: string;
        claimedTabs: number;
      }
    | undefined;
}

/** Agent identity profile for system-reminder injection. */
export interface AgentIdentity {
  display_name?: string | undefined;
}

/** Skill entry for <available_skills> injection. */
export interface SkillEntry {
  name: string;
  description: string;
  scope: "agent" | "global";
  location: string;
}

/**
 * Compact summary of an active team plan owned by the current session —
 * used to render the <active-plan-reminder> block. Only includes fields
 * needed by the reminder so we don't pull the full PlanState into the
 * system-reminder context.
 */
export interface ActivePlanSummary {
  plan_id: string;
  cycle: number;
  phase: string;
  status: string;
  /** Unix-ms timestamp of the last plan-state update. */
  updated_at: number;
}

export interface SystemReminderInput {
  env?: AgentEnv | undefined;
  /** Agent identity for identity reminder injection. */
  identity?: AgentIdentity | undefined;
  /** True when the workspace needs an agent bootstrap (no root AGENTS.md) — triggers bootstrap prompt. */
  needsBootstrap?: boolean | undefined;
  /**
   * True when the workspace directory itself is a git checkout — either a main
   * checkout (`.git` is a directory) or a worktree (`.git` is a gitlink file).
   * Looser than the `isGitWorkspace()`/`checkNeedsBootstrap()` helpers in
   * data-collector: this only inspects the workspace directory itself, not
   * its immediate sub-projects, and accepts the worktree gitlink form. Used
   * by `worktreeReminderProvider` to enforce the worktree workflow on git
   * workspaces; populated via the `isGitCheckout()` helper in data-collector.
   */
  isGitWorkspace?: boolean | undefined;
  /**
   * True when the workspace itself is a git worktree (i.e. the agent is
   * already running inside `.worktrees/<branch>/`). When true, the worktree
   * reminder is suppressed — the agent is presumed to already be following
   * the worktree workflow.
   */
  isInsideWorktree?: boolean | undefined;
  /** Evolution reminder text to inject (memory-write reminder only; skill creation moved to v3 fallback/proposal). */
  evolutionReminder?: string | undefined;
  /** Current snapshot of the agent memory directory, collected by the host. */
  agentMemorySnapshot?: MemoryDirSnapshot | undefined;
  workspaceDir?: string | undefined;
  /** Available skills for this agent (global + agent-specific). */
  skills?: SkillEntry[] | undefined;
  /** Heading-level index of sibling agents' memory — enables cross-agent knowledge discovery. */
  teamMemoryIndex?: string | undefined;
  /** Relevant agent memory sections matched against current user query. */
  relevantMemory?: string | undefined;
  /** Updated agent MEMORY.md content — injected when agent memory changes mid-session. */
  agentMemoryUpdate?: string | undefined;
  /** Updated .summary.md content — injected (full) when summary index is regenerated mid-session. */
  memorySummaryUpdate?: string | undefined;
  /** Updated user memory content — injected when user memory changes mid-session. */
  userMemoryUpdate?: string | undefined;
  dailyMemoryUpdate?: string | undefined;
  /** True only when the host explicitly enables the opt-in proactive-memory reminder. */
  proactiveMemoryEnabled?: boolean | undefined;
  /** Metadata for rendering the local memory-skill reminder without filesystem reads in agent-core. */
  memorySkillReminder?: MemorySkillReminderStatus | undefined;
  /** Topic-file summaries for rendering available memory topics without filesystem reads in agent-core. */
  memoryTopics?: MemoryTopicSummary[] | undefined;
  /** Memory files that predate the mavis CLI removal and still teach removed CLI commands. */
  cliSunsetMemoryNotice?: CliSunsetMemoryNotice | undefined;
  /** Updated identity — injected when PERSONA.md changes mid-session. */
  identityUpdate?: AgentIdentity | undefined;
  /** True when agent config files have been modified mid-session. */
  configUpdate?: boolean | undefined;
  /**
   * True when the agent's PERSONA.md is missing, empty, default, or otherwise too thin
   * for the agent to feel like it has an identity yet — triggers persona setup reminder.
   */
  personaMissing?: boolean | undefined;
  /**
   * Absolute path to the agent's PERSONA.md file (used in `<persona_missing>` block to
   * tell the agent where its persona should live).
   */
  personaPath?: string | undefined;
  /**
   * How the agent was created: 'manual' (user via UI/CLI) or 'auto' (delegation/sync/template).
   * Cold-start reminders (persona_missing, bootstrap_check) only fire
   * for orchestrator agents OR manual workers — `auto` workers stay silent.
   */
  creationSource?: "manual" | "auto" | "builtin" | undefined;
  /** Inbound context metadata extracted from <inbound-context> tag (Layer 1 — trusted metadata). */
  inboundMeta?: Record<string, unknown> | undefined;
  /** Branch sessions that finished without reporting to main. */
  branchNotifications?: Array<{
    branchSessionId: string;
    agentName: string;
    title: string | null;
    /** Unix-ms timestamp when the branch session finished. */
    finishedAt: number;
  }>;
  /**
   * Session-scoped one-shot reminder bodies queued for this session
   * (e.g. session-rotate handoff bootstrap). Already-formatted text — the
   * outer `<system-reminder>` wrapper is added by SystemReminderService.
   * Consumed (cleared) when injected.
   */
  pendingSessionReminders?: string[] | undefined;
  /** Latest active TodoWrite state for this session, if any non-terminal todos remain. */
  activeTodoState?:
    | {
        total: number;
        active: number;
        completed: number;
        cancelled: number;
        lastUpdatedTurn?: number | undefined;
      }
    | undefined;
  /** Current conversation turn count (user messages) for this session. */
  turnCount?: number | undefined;
  /** True when peer list has changed since last injection (not first call). Triggers <peers_update>. */
  peersChanged?: boolean | undefined;
  /** Active team plans owned by this session — drives <active-plan-reminder> for orchestrators. */
  activePlans?: ActivePlanSummary[] | undefined;
  /** When true, suppress team-related system-reminder blocks (reachableSessions, availableAgents, peersUpdate, activePlan). */
  teamModeOff?: boolean | undefined;
  /**
   * True when skill-evolve is enabled AND the agent is not excluded from signal/proposal guidance.
   * Controls injection of the <skill-evolution-channels> teaching block AND the
   * `mavis skill signal report` trigger line inside the <memory-skill-reminder> block.
   */
  skillEvolveEnabled?: boolean | undefined;
  /**
   * True when the skill-proposal pipeline (`skillEvolve.proposal.enabled`) is on
   * for this agent. Independently controls the `mavis skill proposal report`
   * trigger line inside the <memory-skill-reminder> block. Always false when
   * `skillEvolveEnabled` is false (parent gate). The signal trigger line and
   * the proposal trigger line gate independently — when both are off, the
   * skill section is omitted entirely and the agent only sees the
   * three-question memory-layer attribution test.
   */
  skillProposalEnabled?: boolean | undefined;
  /** Effective Mavis feature availability. Undefined preserves cloud/legacy behavior. */
  mavisEnabled?: boolean | undefined;
  /**
   * Effective scheduled-task availability for this turn. `false` on runtime
   * hosts that expose the Mavis tool without a Cron adapter — notably the
   * embedded CLI, which disables Cron alongside memory/browser/CU. Reminders
   * that tell the agent to schedule follow-up work MUST honor this, otherwise
   * they send the agent after a capability the host answers with
   * `CRON_UNSUPPORTED_HOST`. Undefined preserves cloud/legacy behavior.
   */
  cronEnabled?: boolean | undefined;
  /**
   * Available encrypted secret env var names for this turn (e.g.
   * `["OPENAI_API_KEY", "GITHUB_TOKEN"]`). Cloud-runtime path populates
   * this from the per-process `SecretStore.names()`; daemon path leaves
   * it undefined.
   *
   * The provider `secretEnvReminderProvider` emits a `<secret-env>` block
   * listing the names so the agent knows what `${SECRET_NAME}` references
   * are available in shell commands. **Only names** — values are never
   * surfaced to the LLM (the value path is the cloud-bash export prefix
   * + the SecretMasker on outbound text).
   *
   * Semantics:
   *   - undefined → no secret store wired (daemon / legacy / test).
   *     Provider stays silent.
   *   - []        → store exists but empty. Provider stays silent (no
   *     point reminding the agent about nothing).
   *   - non-empty → render the `<secret-env>` block, but only on turn 1
   *     or when the names set has changed since the last injection
   *     (per-session hash; create/update-name/delete via the `secret`
   *     tool naturally triggers a re-inject because the store mutates).
   */
  secretNames?: readonly string[] | undefined;
  /**
   * Per-turn allowlist + policy override for cloud-runtime path. Sourced from
   * `AgentConfig.system_reminders`.
   *
   * Semantics:
   * - `undefined` — legacy / daemon path, no allowlist (every registered
   *   provider runs; preserves existing behaviour).
   * - `[]`        — strict whitelist with zero entries → fail-safe ALL OFF.
   * - non-empty   — only providers whose registry name (stripped of the
   *   `Provider` suffix, see `stripProviderSuffix` in `service.ts`) matches
   *   one of the entries' `name` field are executed. `critical` providers
   *   are NOT bypassed; they go through the same allowlist.
   *
   * Individual backoff/cooldown providers also read `frequency` / `thresholds`
   * off the matching entry to override their hard-coded defaults (see
   * `findReminderPolicy` helper in `providers.ts`).
   */
  systemReminders?: ReadonlyArray<ReminderPolicyEntry> | undefined;
}

// ─── Reminder Policy Entry ─────────────────────────────────────────────────

/**
 * Narrow per-provider policy entry consumed by this package.
 *
 * Cloud-runtime adapts `AgentConfig.system_reminders` into this structural
 * shape. The wire protocol may carry extra fields such as `critical` or
 * `frequency.type`; system-reminder intentionally does not expose those as
 * part of its package contract because providers only read `name`,
 * `frequency.intervals`, and selected numeric `thresholds`.
 */
export interface ReminderPolicyEntry {
  name: string;
  frequency?: ReminderPolicyFrequency | undefined;
  thresholds?: ReminderPolicyThresholds | undefined;
}

export interface ReminderPolicyFrequency {
  intervals?: ReadonlyArray<number | string> | undefined;
}

export interface ReminderPolicyThresholds {
  cooldown_ms?: number | string | undefined;
  todo_reminder_interval_turns?: number | string | undefined;
}

// ─── Evolution Config ────────────────────────────────────────────────────────

export const EVOLUTION_CONFIG = {
  /** First memory-write reminder fires after this many turns. */
  MEMORY_REMINDER_INITIAL_INTERVAL: 10,
  /** Max interval after exponential back-off (caps doubling). */
  MEMORY_REMINDER_MAX_INTERVAL: 40,
  /**
   * @deprecated v3: skill-crystallization in-turn reminder removed —
   * skill reflection now happens at session end via the daily-digest
   * fallback re-prompt. Constants kept for back-compat with any external
   * imports / tests; not read by `getEvolutionReminder` anymore.
   */
  SKILL_REMINDER_THRESHOLD: 5,
  /** @deprecated v3: see SKILL_REMINDER_THRESHOLD. */
  SKILL_REMINDER_INITIAL_INTERVAL: 10,
  /** @deprecated v3: see SKILL_REMINDER_THRESHOLD. */
  SKILL_REMINDER_MAX_INTERVAL: 40,
  /** @deprecated v3: see SKILL_REMINDER_THRESHOLD. */
  SKILL_REMINDER_INTERVAL: 20,
} as const;

// ─── Memory Snapshot ─────────────────────────────────────────────────────────

export interface MemoryDirSnapshot {
  files: string[];
  maxMtime: number;
}

export interface MemorySkillReminderStatus {
  /** Absolute or host-native canonical path/id of the agent MEMORY.md. */
  path: string;
  lines: number;
  sizeBytes: number;
}

export interface MemoryTopicSummary {
  name: string;
  description: string;
  path: string;
}

/** Stale-memory warning payload for the <cli-sunset-memory-notice> block. */
export interface CliSunsetMemoryNotice {
  /** Absolute paths of memory files that still reference removed mavis CLI commands. */
  paths: string[];
  /** Paths referencing `mavis team` — a surviving CLI whose workflows changed; advisory tier. */
  teamPaths?: string[];
}
