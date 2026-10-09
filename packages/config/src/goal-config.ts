export type GoalVerificationMode = 'none' | 'evaluator' | 'subagent';

export const GOAL_VERIFICATION_MODES = ['none', 'evaluator', 'subagent'] as const;
export const GOAL_VERIFICATION_EVIDENCE_MODES = ['brief', 'transcript'] as const;
export type GoalVerificationEvidenceMode = (typeof GOAL_VERIFICATION_EVIDENCE_MODES)[number];
export const GOAL_EVALUATOR_MODEL_POLICIES = ['same-route-small-fast'] as const;
export const GOAL_VERIFIER_READONLY_PROFILE = 'goal-verifier-readonly';
export const GOAL_SUBAGENT_PROFILES = [GOAL_VERIFIER_READONLY_PROFILE] as const;
/**
 * Network tools a Goal verifier child never receives. Verification adjudicates
 * the workspace from local evidence, so these are withheld from the child's tool
 * catalog, and the child's runtime guard refuses any call that still arrives.
 */
export const GOAL_VERIFIER_OFFLINE_TOOL_NAMES: readonly string[] = ['web_fetch', 'web_search'];

export interface GoalConfig {
  /** Optional objective length cap. Absent means unlimited. */
  objectiveMaxChars?: number;
  /**
   * Deliberately has no default and is never written during initialization:
   * only a value the user typed into the config file takes effect. When it is
   * absent the runtime derives the mode from the model route actually in use.
   */
  verification?: GoalVerificationMode;
  budget: {
    /** Optional worker token cap for Goals without a per-Goal token budget. */
    defaultTokens?: number;
    /** Optional worker Turn cap. */
    defaultMainTurns?: number;
    /** Optional active execution-time cap. */
    defaultActiveSeconds?: number;
    graceSteps: number;
  };
  breaker: {
    /** Total consecutive identical reply occurrences before the Goal pauses. */
    repeatedReplyLimit: number;
  };
  verifier: {
    repeatedNotMetLimit: number;
    /** Rollback switch for the verifier input redesign. New installs use the bounded brief. */
    evidence: GoalVerificationEvidenceMode;
  };
  evaluator: {
    modelPolicy: (typeof GOAL_EVALUATOR_MODEL_POLICIES)[number];
    maxTokens: number;
    timeoutSeconds: number;
    maxRetries: number;
  };
  /** Optional verifier-child limits. Absent leaves impose no corresponding limit. */
  subagent?: {
    profile?: (typeof GOAL_SUBAGENT_PROFILES)[number];
    maxTurns?: number;
    maxTokens?: number;
    timeoutSeconds?: number;
  };
}

export interface PartialGoalConfig {
  objectiveMaxChars?: number;
  verification?: GoalVerificationMode;
  budget?: Partial<GoalConfig['budget']>;
  breaker?: Partial<GoalConfig['breaker']>;
  verifier?: Partial<GoalConfig['verifier']>;
  evaluator?: Partial<GoalConfig['evaluator']>;
  subagent?: Partial<NonNullable<GoalConfig['subagent']>>;
}

export const GOAL_CONFIG_DEFAULTS: GoalConfig = {
  budget: {
    graceSteps: 1,
  },
  breaker: { repeatedReplyLimit: 3 },
  verifier: { repeatedNotMetLimit: 5, evidence: 'brief' },
  evaluator: {
    modelPolicy: 'same-route-small-fast',
    maxTokens: 32_000,
    timeoutSeconds: 60,
    maxRetries: 1,
  },
};

export const GOAL_CONFIG_LIMITS = {
  budget: { graceSteps: 3 },
  evaluator: { maxRetries: 1 },
} as const;

export interface GoalConfigParseResult {
  readonly config: GoalConfig;
  readonly warnings: readonly string[];
}

/**
 * Goal configuration is deliberately fault-tolerant: one malformed Goal leaf
 * must not make the process-wide configuration unavailable. Invalid leaves
 * fall back independently, optional limits are dropped, bounded values are
 * clamped, and every correction is returned as a startup diagnostic.
 */
export function parseGoalConfig(raw: unknown): GoalConfigParseResult {
  const warnings: string[] = [];
  const goal = goalObject(raw, 'goal', warnings);
  warnUnknownKeys(goal, 'goal', warnings, [
    'objectiveMaxChars',
    'verification',
    'budget',
    'breaker',
    'verifier',
    'evaluator',
    'subagent',
  ]);

  const budget = goalObject(goal.budget, 'goal.budget', warnings);
  warnUnknownKeys(budget, 'goal.budget', warnings, [
    'defaultTokens',
    'defaultMainTurns',
    'defaultActiveSeconds',
    'graceSteps',
  ]);
  const breaker = goalObject(goal.breaker, 'goal.breaker', warnings);
  warnUnknownKeys(breaker, 'goal.breaker', warnings, ['repeatedReplyLimit']);
  const verifier = goalObject(goal.verifier, 'goal.verifier', warnings);
  warnUnknownKeys(verifier, 'goal.verifier', warnings, ['repeatedNotMetLimit', 'evidence']);
  const evaluator = goalObject(goal.evaluator, 'goal.evaluator', warnings);
  warnUnknownKeys(evaluator, 'goal.evaluator', warnings, [
    'modelPolicy',
    'maxTokens',
    'timeoutSeconds',
    'maxRetries',
  ]);
  const subagent = goalObject(goal.subagent, 'goal.subagent', warnings);
  warnUnknownKeys(subagent, 'goal.subagent', warnings, [
    'profile',
    'maxTurns',
    'maxTokens',
    'timeoutSeconds',
  ]);

  // No default and no initialization: an absent (or invalid) value leaves the
  // key off entirely so the runtime falls through to route-derived resolution.
  const verification = goalOptionalEnum(
    goal.verification,
    'goal.verification',
    GOAL_VERIFICATION_MODES,
    warnings,
  );
  const objectiveMaxChars = goalOptionalInteger(
    goal.objectiveMaxChars,
    'goal.objectiveMaxChars',
    warnings,
    { min: 1 },
  );
  const defaultTokens = goalOptionalInteger(
    budget.defaultTokens,
    'goal.budget.defaultTokens',
    warnings,
    { min: 1 },
  );
  const defaultMainTurns = goalOptionalInteger(
    budget.defaultMainTurns,
    'goal.budget.defaultMainTurns',
    warnings,
    { min: 1 },
  );
  const defaultActiveSeconds = goalOptionalInteger(
    budget.defaultActiveSeconds,
    'goal.budget.defaultActiveSeconds',
    warnings,
    { min: 1 },
  );
  const subagentProfile = goalOptionalEnum(
    subagent.profile,
    'goal.subagent.profile',
    GOAL_SUBAGENT_PROFILES,
    warnings,
  );
  const subagentMaxTurns = goalOptionalInteger(
    subagent.maxTurns,
    'goal.subagent.maxTurns',
    warnings,
    { min: 1 },
  );
  const subagentMaxTokens = goalOptionalInteger(
    subagent.maxTokens,
    'goal.subagent.maxTokens',
    warnings,
    { min: 1 },
  );
  const subagentTimeoutSeconds = goalOptionalInteger(
    subagent.timeoutSeconds,
    'goal.subagent.timeoutSeconds',
    warnings,
    { min: 1 },
  );
  const parsedSubagent = {
    ...(subagentProfile !== undefined ? { profile: subagentProfile } : {}),
    ...(subagentMaxTurns !== undefined ? { maxTurns: subagentMaxTurns } : {}),
    ...(subagentMaxTokens !== undefined ? { maxTokens: subagentMaxTokens } : {}),
    ...(subagentTimeoutSeconds !== undefined ? { timeoutSeconds: subagentTimeoutSeconds } : {}),
  };

  return {
    config: {
      ...(objectiveMaxChars !== undefined ? { objectiveMaxChars } : {}),
      ...(verification !== undefined ? { verification } : {}),
      budget: {
        ...(defaultTokens !== undefined ? { defaultTokens } : {}),
        ...(defaultMainTurns !== undefined ? { defaultMainTurns } : {}),
        ...(defaultActiveSeconds !== undefined ? { defaultActiveSeconds } : {}),
        graceSteps: goalInteger(
          budget.graceSteps,
          'goal.budget.graceSteps',
          GOAL_CONFIG_DEFAULTS.budget.graceSteps,
          warnings,
          { min: 0, max: GOAL_CONFIG_LIMITS.budget.graceSteps },
        ),
      },
      breaker: {
        repeatedReplyLimit: goalInteger(
          breaker.repeatedReplyLimit,
          'goal.breaker.repeatedReplyLimit',
          GOAL_CONFIG_DEFAULTS.breaker.repeatedReplyLimit,
          warnings,
          { min: 1 },
        ),
      },
      verifier: {
        repeatedNotMetLimit: goalInteger(
          verifier.repeatedNotMetLimit,
          'goal.verifier.repeatedNotMetLimit',
          GOAL_CONFIG_DEFAULTS.verifier.repeatedNotMetLimit,
          warnings,
          { min: 1 },
        ),
        evidence: goalEnum(
          verifier.evidence,
          'goal.verifier.evidence',
          GOAL_VERIFICATION_EVIDENCE_MODES,
          GOAL_CONFIG_DEFAULTS.verifier.evidence,
          warnings,
        ),
      },
      evaluator: {
        modelPolicy: goalEnum(
          evaluator.modelPolicy,
          'goal.evaluator.modelPolicy',
          GOAL_EVALUATOR_MODEL_POLICIES,
          GOAL_CONFIG_DEFAULTS.evaluator.modelPolicy,
          warnings,
        ),
        maxTokens: goalInteger(
          evaluator.maxTokens,
          'goal.evaluator.maxTokens',
          GOAL_CONFIG_DEFAULTS.evaluator.maxTokens,
          warnings,
          { min: 1 },
        ),
        timeoutSeconds: goalInteger(
          evaluator.timeoutSeconds,
          'goal.evaluator.timeoutSeconds',
          GOAL_CONFIG_DEFAULTS.evaluator.timeoutSeconds,
          warnings,
          { min: 1 },
        ),
        maxRetries: goalInteger(
          evaluator.maxRetries,
          'goal.evaluator.maxRetries',
          GOAL_CONFIG_DEFAULTS.evaluator.maxRetries,
          warnings,
          { min: 0, max: GOAL_CONFIG_LIMITS.evaluator.maxRetries },
        ),
      },
      ...(Object.keys(parsedSubagent).length > 0 ? { subagent: parsedSubagent } : {}),
    },
    warnings,
  };
}

function goalObject(raw: unknown, path: string, warnings: string[]): Record<string, unknown> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(goalWarning(path, 'expected an object; using defaults'));
    return {};
  }
  return raw as Record<string, unknown>;
}

function warnUnknownKeys(
  raw: Record<string, unknown>,
  path: string,
  warnings: string[],
  allowed: readonly string[],
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) warnings.push(goalWarning(`${path}.${key}`, 'unknown key ignored'));
  }
}

function goalInteger(
  raw: unknown,
  path: string,
  fallback: number,
  warnings: string[],
  range: { readonly min: number; readonly max?: number },
): number {
  if (raw == null) return fallback;
  if (!Number.isInteger(raw) || (raw as number) < range.min) {
    warnings.push(goalWarning(path, `expected an integer >= ${range.min}; using default`));
    return fallback;
  }
  if (range.max != null && (raw as number) > range.max) {
    warnings.push(goalWarning(path, `exceeds maximum ${range.max}; clamped`));
    return range.max;
  }
  return raw as number;
}

/** Parse an opt-in integer limit without inventing a fallback policy. */
function goalOptionalInteger(
  raw: unknown,
  path: string,
  warnings: string[],
  range: { readonly min: number; readonly max?: number },
): number | undefined {
  if (raw == null) return undefined;
  if (!Number.isInteger(raw) || (raw as number) < range.min) {
    warnings.push(goalWarning(path, `expected an integer >= ${range.min}; ignored`));
    return undefined;
  }
  if (range.max != null && (raw as number) > range.max) {
    warnings.push(goalWarning(path, `exceeds maximum ${range.max}; clamped`));
    return range.max;
  }
  return raw as number;
}

function goalEnum<const T extends readonly string[]>(
  raw: unknown,
  path: string,
  allowed: T,
  fallback: T[number],
  warnings: string[],
): T[number] {
  if (raw == null) return fallback;
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    warnings.push(goalWarning(path, `expected one of: ${allowed.join(', ')}; using default`));
    return fallback;
  }
  return raw as T[number];
}

/**
 * Like {@link goalEnum} but with no fallback: the key is only produced when the
 * user supplied a valid value. An invalid value is reported and dropped rather
 * than silently becoming a policy the user never asked for.
 */
function goalOptionalEnum<const T extends readonly string[]>(
  raw: unknown,
  path: string,
  allowed: T,
  warnings: string[],
): T[number] | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    warnings.push(goalWarning(path, `expected one of: ${allowed.join(', ')}; ignored`));
    return undefined;
  }
  return raw as T[number];
}

function goalWarning(path: string, message: string): string {
  return `Invalid goal config at ${path}: ${message}`;
}
