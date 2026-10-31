/**
 * Remote rollout policy for the next-message suggestion, sourced from Apollo
 * `agent_config.prompt_suggestion`. The user's own choice stays local
 * (`promptSuggestion.enabled` in config.yaml) and always wins; the remote
 * policy sets the default for users who never chose (on when absent), and the
 * kill switch and sampling narrow everyone.
 */
export interface PromptSuggestionRemotePolicy {
  /** True stops every generation and restore, whatever the user opted into. */
  readonly killSwitch?: boolean;
  /** Fraction of Sessions eligible, in [0, 1]. */
  readonly sampleRate?: number;
  /** Opt-in for users who never chose. Absent means on. */
  readonly defaultEnabled?: boolean;
}

/**
 * Accepts the Apollo object (`kill_switch`, `sample_rate`, `default_enabled`).
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
  return {
    ...(typeof killSwitch === 'boolean' ? { killSwitch } : {}),
    ...(typeof sampleRate === 'number' &&
    Number.isFinite(sampleRate) &&
    sampleRate >= 0 &&
    sampleRate <= 1
      ? { sampleRate }
      : {}),
    ...(typeof defaultEnabled === 'boolean' ? { defaultEnabled } : {}),
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

/**
 * Fills the effective opt-in into a config snapshot, so the runtime and the
 * config the UI reads see one value instead of each re-deriving it.
 */
export function withEffectivePromptSuggestion<
  T extends { readonly promptSuggestion?: { readonly enabled?: boolean } },
>(config: T, remote: PromptSuggestionRemotePolicy | undefined): T {
  const enabled = resolvePromptSuggestionEnabled(config.promptSuggestion?.enabled, remote);
  return { ...config, promptSuggestion: { ...config.promptSuggestion, enabled } };
}
