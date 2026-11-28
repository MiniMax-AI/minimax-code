/**
 * Remote rollout policy for the next-message suggestion, sourced from Apollo
 * `agent_config.prompt_suggestion`. The user's own choice stays local
 * (`promptSuggestion.enabled` in config.yaml) and always wins; the remote
 * policy sets the default for users who never chose (on when absent), and the
 * kill switch and sampling narrow everyone.
 *
 * The same object carries the defaults of the end-of-turn Next Step card
 * (`next_step_default_enabled`) and of task suggestion cards
 * (`task_suggestion_default_enabled`). The defaults are independent, and the
 * kill switch and sampling apply to the suggestion only.
 */
export interface PromptSuggestionRemotePolicy {
  /** True stops every generation and restore, whatever the user opted into. */
  readonly killSwitch?: boolean;
  /** Fraction of Sessions eligible, in [0, 1]. */
  readonly sampleRate?: number;
  /** Opt-in for users who never chose. Absent means on. */
  readonly defaultEnabled?: boolean;
  /** Next Step card opt-in for users who never chose. Absent means on. */
  readonly nextStepDefaultEnabled?: boolean;
  /** Task suggestion opt-in for users who never chose. Absent means on. */
  readonly taskSuggestionDefaultEnabled?: boolean;
}

/**
 * The user's own choice for the end-of-turn Next Step card. Absent means the
 * user never chose; `resolveNextStepBoxEnabled` turns that into the effective
 * value (the remote default from the same Apollo policy, on when absent).
 */
export interface NextStepBoxConfig {
  enabled?: boolean;
}

/** Reads `{ enabled }` for a switch whose default the remote policy decides. */
export function parseExplicitEnabled(value: unknown): { enabled?: boolean } {
  const enabled =
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).enabled
      : undefined;
  // Keep "never chose" distinct from an explicit `false`: the effective default
  // depends on the remote policy, which parsing cannot see.
  return typeof enabled === 'boolean' ? { enabled } : {};
}

/**
 * Accepts the Apollo object (`kill_switch`, `sample_rate`, `default_enabled`,
 * `next_step_default_enabled`, `task_suggestion_default_enabled`).
 * Missing or invalid fields mean "no override", like the Runaway Guard
 * override: a malformed remote value never throws and never blocks the runtime
 * from starting.
 */
export function parsePromptSuggestionRemotePolicy(raw: unknown): PromptSuggestionRemotePolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const killSwitch = record.kill_switch ?? record.killSwitch;
  const sampleRate = record.sample_rate ?? record.sampleRate;
  const defaultEnabled = record.default_enabled ?? record.defaultEnabled;
  const nextStepDefaultEnabled = record.next_step_default_enabled ?? record.nextStepDefaultEnabled;
  const taskSuggestionDefaultEnabled =
    record.task_suggestion_default_enabled ?? record.taskSuggestionDefaultEnabled;
  return {
    ...(typeof killSwitch === 'boolean' ? { killSwitch } : {}),
    ...(typeof sampleRate === 'number' &&
    Number.isFinite(sampleRate) &&
    sampleRate >= 0 &&
    sampleRate <= 1
      ? { sampleRate }
      : {}),
    ...(typeof defaultEnabled === 'boolean' ? { defaultEnabled } : {}),
    ...(typeof nextStepDefaultEnabled === 'boolean' ? { nextStepDefaultEnabled } : {}),
    ...(typeof taskSuggestionDefaultEnabled === 'boolean' ? { taskSuggestionDefaultEnabled } : {}),
  };
}

/**
 * The opt-in a Session actually runs with. An explicit user choice always
 * wins; otherwise the remote default decides, and the feature is on when no
 * remote default is configured. No build, account or model is special-cased.
 */
export function resolvePromptSuggestionEnabled(
  explicit: boolean | undefined,
  remote: PromptSuggestionRemotePolicy | undefined,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return remote?.defaultEnabled ?? true;
}

/** The Next Step card's effective opt-in, by the same rule as the suggestion. */
export function resolveNextStepBoxEnabled(
  explicit: boolean | undefined,
  remote: PromptSuggestionRemotePolicy | undefined,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return remote?.nextStepDefaultEnabled ?? true;
}

/** Task suggestion cards' effective opt-in, by the same rule as the suggestion. */
export function resolveTaskSuggestionEnabled(
  explicit: boolean | undefined,
  remote: PromptSuggestionRemotePolicy | undefined,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return remote?.taskSuggestionDefaultEnabled ?? true;
}

/**
 * Fills the effective opt-ins this policy decides (the next-message suggestion
 * and the Next Step card) into a config snapshot, so the runtime and the config
 * the UI reads see one value instead of each re-deriving it.
 */
export function withEffectivePromptSuggestion<
  T extends {
    readonly promptSuggestion?: { readonly enabled?: boolean };
    readonly nextStepBox?: { readonly enabled?: boolean };
    readonly taskSuggestion?: { readonly enabled?: boolean };
  },
>(config: T, remote: PromptSuggestionRemotePolicy | undefined): T {
  const enabled = resolvePromptSuggestionEnabled(config.promptSuggestion?.enabled, remote);
  const nextStepEnabled = resolveNextStepBoxEnabled(config.nextStepBox?.enabled, remote);
  const taskSuggestionEnabled = resolveTaskSuggestionEnabled(
    config.taskSuggestion?.enabled,
    remote,
  );
  return {
    ...config,
    promptSuggestion: { ...config.promptSuggestion, enabled },
    nextStepBox: { ...config.nextStepBox, enabled: nextStepEnabled },
    taskSuggestion: { ...config.taskSuggestion, enabled: taskSuggestionEnabled },
  };
}
