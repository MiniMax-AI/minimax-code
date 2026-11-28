/**
 * Skill-evolve configuration types, defaults, lifecycle helpers and the
 * runtime parser. Extracted from `config.ts` to keep the main schema file
 * under the source-size guard. The resolved beta gates are passed in by
 * `config.ts` so this module never imports it back.
 */

export interface SkillEvolveInSessionConfig {
  /** Trigger a scan every N agent turns. */
  N: number;
  /** Minimum seconds between two scans in the same session. */
  minIntervalSeconds: number;
  /** Maximum pending scans per session (no new scan while one is in flight). */
  maxPendingPerSession: number;
}

/** Lifecycle thresholds (15d/30d defaults; legacy 30d/90d). Schema enforces stale < archive. */
export interface SkillEvolveLifecycleConfig {
  /** Days idle before `state='stale'`. */
  staleThresholdDays: number;
  /** Days idle before non-builtin moved to `.archive/`. */
  archiveThresholdDays: number;
}

export interface SkillEvolveConfig {
  /**
   * Master switch. When false, signal collection, scanning, routing, and
   * editor spawning are all disabled. API endpoints return 403.
   *
   * Auto-derived when not explicitly set in config.yaml: if **all**
   * configured model IDs start with a prefix in `disableModelPrefixes`
   * (case-insensitive), defaults to `false`; otherwise `true`.
   * No models configured also defaults to `false`.
   * An explicit `enabled: true/false` in config.yaml always wins.
   */
  enabled: boolean;
  /** In-session scan throttle parameters. */
  inSession: SkillEvolveInSessionConfig;
  /** Cooldown hours for same-skill same-fingerprint signals (default 24). */
  signalCooldownHours: number;
  /** Minimum confidence for scanner output (below → auto-downgrade or discard). */
  minConfidence: number;
  /** Model for the passive scanner LLM calls. */
  scannerModel?: string;
  /** Agent names excluded from signal generation (e.g. 'skill-editor'). */
  excludeAgents: string[];
  /**
   * Model ID prefixes for which skill-evolve is disabled per-session.
   * When the resolved model ID starts with any of these prefixes,
   * skill-evolve teaching and scan triggers are suppressed for that session.
   * Also used to auto-derive the global `enabled` flag when it is not
   * explicitly set: if all configured model IDs match one of these prefixes
   * (or no models are configured), `enabled` defaults to `false`.
   * Default: ['MiniMax-M2'].
   */
  disableModelPrefixes: string[];
  /**
   * Whether the nightly evolver may handle built-in skill signals by
   * dispatching a worker that opens a GitLab MR against the daemon source
   * repo. When false, built-in signals are dismissed (legacy behavior).
   *
   * Mirrors `BetaConfig.skillEvolveBuiltinMr` — the beta gate is limited to
   * the test channel and wins first; this resolved field is what the
   * internal-scheduler reads when injecting capability hints into the
   * `skill-evolve-nightly` SKILL.md prompt.
   *
   * Default `false` — opt-in. Even with the beta gate enabled, opening MRs
   * against a source repo is an externally visible side effect, so users
   * must explicitly set `skillEvolve.builtinMrEnabled: true` (alongside
   * `sourceRepo`) to participate. Mirrors the `sourceRepo: undefined`
   * default — both must be set together.
   *
   * Implicitly false when the parent `enabled` is false (no point evolving
   * built-ins if the whole pipeline is off).
   */
  builtinMrEnabled: boolean;
  /**
   * Optional absolute path to the source repository used for built-in skill
   * evolution MRs. Runtime built-in skills usually live under the dataDir copy
   * (`.minimax/.builtin-skills`), so walking up from that directory cannot find
   * the repo in packaged/dev-profile installs. When set, the internal nightly
   * scheduler validates this path and uses it as the MR source repo.
   */
  sourceRepo?: string;
  /**
   * v3: skill creation proposal pipeline (session-end fallback re-prompt
   * → ProposalStore → nightly skill-evolve consumes). When the parent
   * `enabled` is false, all proposal sub-features are forced off.
   *
   * Mirrors `BetaConfig.skillProposal` — its beta definition defaults through
   * test and is configurable through online. That gate wins first; this
   * resolved object is what the daily-digest fallback and scanner read.
   */
  proposal: SkillEvolveProposalConfig;
  /** Lifecycle thresholds — see `SkillEvolveLifecycleConfig`. */
  lifecycle: SkillEvolveLifecycleConfig;
}

/**
 * v3: proposal pipeline configuration. Controls who receives the
 * session-end fallback re-prompt for skill reflection and whether the
 * legacy session-end passive scanner is suppressed in favor of the new flow.
 */
export interface SkillEvolveProposalConfig {
  /**
   * Resolved master switch. False when:
   *   - `skillEvolve.enabled` is false (parent gate)
   *   - `beta.skillProposal` is false (beta gate)
   * True when both gates are on.
   */
  enabled: boolean;
  /**
   * Agent name allow-list for fallback re-prompt + skill reflection.
   * Special value `["*"]` enables all agents.
   * Default: `["mavis"]`.
   */
  eligibleAgents: string[];
  /**
   * Minimum message count before a session is eligible for skill-reflection
   * re-prompt (independent of the memory-fallback minimum). Default: 40.
   */
  minMessageCount: number;
  /**
   * When true (default in v3), the passive scanner does NOT subscribe to
   * `session.finish` / `session.error` / `session.compressed` EventBus
   * events — the daily-digest fallback re-prompt covers that need with
   * higher accuracy (the original agent reflects on its own conversation).
   *
   * The in-session `scan-request` path is unaffected and continues to fire.
   *
   * Set to `false` to keep the legacy v2 behavior (both paths produce
   * signals, expect duplicate signal volume).
   */
  skipPassiveSessionEnd: boolean;
}

/**
 * v3 helper: check whether an agent is in the proposal eligibility list.
 *
 * - `["*"]` matches every agent
 * - Otherwise an exact name match
 *
 * Empty list always returns false.
 */
export function isProposalEligibleAgent(agentName: string, eligibleAgents: string[]): boolean {
  if (eligibleAgents.length === 0) return false;
  if (eligibleAgents.includes('*')) return true;
  return eligibleAgents.includes(agentName);
}

export const SKILL_EVOLVE_CONFIG_DEFAULTS: SkillEvolveConfig = {
  enabled: true,
  inSession: {
    N: 20,
    minIntervalSeconds: 30,
    maxPendingPerSession: 1,
  },
  signalCooldownHours: 24,
  minConfidence: 0.7,
  excludeAgents: ['skill-editor'],
  disableModelPrefixes: ['MiniMax-M2'],
  builtinMrEnabled: false,
  sourceRepo: undefined,
  proposal: {
    enabled: false,
    eligibleAgents: ['mavis'],
    minMessageCount: 40,
    skipPassiveSessionEnd: true,
  },
  lifecycle: { staleThresholdDays: 15, archiveThresholdDays: 30 }, // tightened from legacy 30d/90d
};

// ── Skill Evolve config parsing ─────────────────────────────────

/**
 * Collect all model IDs from the provider config.
 * Returns an empty array when no models are configured.
 */
function collectModelIds(raw: Record<string, unknown>): string[] {
  const providerRaw = raw.provider;
  if (providerRaw == null || typeof providerRaw !== 'object' || Array.isArray(providerRaw)) {
    return [];
  }
  const ids: string[] = [];
  for (const prov of Object.values(providerRaw as Record<string, unknown>)) {
    if (prov == null || typeof prov !== 'object' || Array.isArray(prov)) continue;
    const { models } = prov as Record<string, unknown>;
    if (models == null || typeof models !== 'object' || Array.isArray(models)) continue;
    ids.push(...Object.keys(models as Record<string, unknown>));
  }
  return ids;
}

/**
 * Auto-derive the `skillEvolve.enabled` flag from the configured model list.
 *
 * When **every** configured model ID starts with one of the
 * `disableModelPrefixes` (case-insensitive), skill-evolve has no capable
 * model to work with, so it is disabled automatically.
 * If at least one model does NOT match, the feature is enabled.
 *
 * Edge cases: no providers / no models configured → `false`
 * (no capable model means the feature cannot operate).
 */
function deriveSkillEvolveEnabled(
  raw: Record<string, unknown>,
  disableModelPrefixes: string[],
): boolean {
  if (disableModelPrefixes.length === 0) return true;
  const modelIds = collectModelIds(raw);
  if (modelIds.length === 0) return false;
  const lowerPrefixes = disableModelPrefixes.map((p) => p.toLowerCase());
  return !modelIds.every((id) => lowerPrefixes.some((p) => id.toLowerCase().startsWith(p)));
}

function parsePositiveDays(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolved `beta.*` gates that bound the skill-evolve pipeline. */
export interface SkillEvolveBetaGates {
  skillEvolve: boolean;
  skillEvolveBuiltinMr: boolean;
  skillProposal: boolean;
}

export function parseSkillEvolveConfig(
  raw: Record<string, unknown>,
  betaConfig: SkillEvolveBetaGates,
): SkillEvolveConfig {
  const defaults = SKILL_EVOLVE_CONFIG_DEFAULTS;
  const se = raw.skillEvolve;
  const hasSection = se != null && typeof se === 'object' && !Array.isArray(se);
  const obj = hasSection ? (se as Record<string, unknown>) : ({} as Record<string, unknown>);

  const inSessionRaw = obj.inSession;
  let { inSession } = defaults;
  if (inSessionRaw != null && typeof inSessionRaw === 'object' && !Array.isArray(inSessionRaw)) {
    const ins = inSessionRaw as Record<string, unknown>;
    inSession = {
      N: typeof ins.N === 'number' && ins.N > 0 ? ins.N : defaults.inSession.N,
      minIntervalSeconds:
        typeof ins.minIntervalSeconds === 'number' && ins.minIntervalSeconds >= 0
          ? ins.minIntervalSeconds
          : defaults.inSession.minIntervalSeconds,
      maxPendingPerSession:
        typeof ins.maxPendingPerSession === 'number' && ins.maxPendingPerSession >= 1
          ? ins.maxPendingPerSession
          : defaults.inSession.maxPendingPerSession,
    };
  }

  const excludeRaw = obj.excludeAgents;
  const excludeAgents =
    Array.isArray(excludeRaw) && excludeRaw.every((e) => typeof e === 'string')
      ? (excludeRaw as string[])
      : defaults.excludeAgents;

  const disableModelPrefixes =
    Array.isArray(obj.disableModelPrefixes) &&
    obj.disableModelPrefixes.every((e: unknown) => typeof e === 'string')
      ? (obj.disableModelPrefixes as string[])
      : defaults.disableModelPrefixes;

  // `enabled` — beta gate wins first; then explicit config; then auto-derive from model list.
  const enabled = !betaConfig.skillEvolve
    ? false
    : typeof obj.enabled === 'boolean'
      ? obj.enabled
      : deriveSkillEvolveEnabled(raw, disableModelPrefixes);

  // `builtinMrEnabled` — beta gate wins first; then explicit config; then default.
  // Implicitly false when the parent `enabled` is false (no point evolving built-ins
  // when the pipeline as a whole is off).
  const builtinMrEnabled = !enabled
    ? false
    : !betaConfig.skillEvolveBuiltinMr
      ? false
      : typeof obj.builtinMrEnabled === 'boolean'
        ? obj.builtinMrEnabled
        : defaults.builtinMrEnabled;

  const sourceRepoRaw = obj.sourceRepo;
  const sourceRepo =
    typeof sourceRepoRaw === 'string' && sourceRepoRaw.trim().length > 0
      ? sourceRepoRaw.trim()
      : defaults.sourceRepo;

  // v3: `proposal` — beta gate + parent gate must both be true; otherwise
  // resolved sub-config still parses but `enabled` is forced false. Other
  // fields (eligibleAgents, minMessageCount, skipPassiveSessionEnd) are
  // honored even when the gate is off so operators can pre-stage config.
  const proposalRaw = obj.proposal;
  const proposalDefaults = defaults.proposal;
  const proposalObj =
    proposalRaw != null && typeof proposalRaw === 'object' && !Array.isArray(proposalRaw)
      ? (proposalRaw as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const proposalEligibleAgents =
    Array.isArray(proposalObj.eligibleAgents) &&
    proposalObj.eligibleAgents.every((e) => typeof e === 'string')
      ? (proposalObj.eligibleAgents as string[])
      : proposalDefaults.eligibleAgents;

  const proposalMinMessageCount =
    typeof proposalObj.minMessageCount === 'number' && proposalObj.minMessageCount >= 1
      ? Math.floor(proposalObj.minMessageCount)
      : proposalDefaults.minMessageCount;

  const proposalSkipPassiveSessionEnd =
    typeof proposalObj.skipPassiveSessionEnd === 'boolean'
      ? proposalObj.skipPassiveSessionEnd
      : proposalDefaults.skipPassiveSessionEnd;

  const proposalEnabledExplicit =
    typeof proposalObj.enabled === 'boolean' ? proposalObj.enabled : null;
  const proposalEnabled = !enabled
    ? false
    : !betaConfig.skillProposal
      ? false
      : (proposalEnabledExplicit ?? true);

  // `lifecycle` — strict invariant stale < archive (fail-fast at boot).
  const lcRaw = obj.lifecycle;
  const lc =
    lcRaw && typeof lcRaw === 'object' && !Array.isArray(lcRaw)
      ? (lcRaw as Record<string, unknown>)
      : {};
  const staleThresholdDays = parsePositiveDays(lc.staleThresholdDays, defaults.lifecycle.staleThresholdDays); // prettier-ignore
  const archiveThresholdDays = parsePositiveDays(lc.archiveThresholdDays, defaults.lifecycle.archiveThresholdDays); // prettier-ignore
  if (!(staleThresholdDays < archiveThresholdDays)) {
    throw new Error(
      `Invalid skillEvolve.lifecycle config: staleThresholdDays (${staleThresholdDays}) must be strictly less than archiveThresholdDays (${archiveThresholdDays}).`,
    );
  }

  return {
    enabled,
    inSession,
    signalCooldownHours:
      typeof obj.signalCooldownHours === 'number' && obj.signalCooldownHours > 0
        ? obj.signalCooldownHours
        : defaults.signalCooldownHours,
    minConfidence:
      typeof obj.minConfidence === 'number' && obj.minConfidence >= 0 && obj.minConfidence <= 1
        ? obj.minConfidence
        : defaults.minConfidence,
    scannerModel: typeof obj.scannerModel === 'string' ? obj.scannerModel : undefined,
    excludeAgents,
    disableModelPrefixes,
    builtinMrEnabled,
    sourceRepo,
    proposal: {
      enabled: proposalEnabled,
      eligibleAgents: proposalEligibleAgents,
      minMessageCount: proposalMinMessageCount,
      skipPassiveSessionEnd: proposalSkipPassiveSessionEnd,
    },
    lifecycle: { staleThresholdDays, archiveThresholdDays },
  };
}
