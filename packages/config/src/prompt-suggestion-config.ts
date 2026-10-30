/**
 * Remote rollout policy for the next-message suggestion, sourced from Apollo
 * `agent_config.prompt_suggestion`. The user opt-in stays local
 * (`promptSuggestion.enabled` in config.yaml); this policy can only narrow it.
 */
export interface PromptSuggestionRemotePolicy {
  /** True stops every generation and restore, whatever the user opted into. */
  readonly killSwitch?: boolean;
  /** Fraction of Sessions eligible, in [0, 1]. */
  readonly sampleRate?: number;
}

/**
 * Accepts the Apollo object (`kill_switch`, `sample_rate`). Missing or invalid
 * fields mean "no override", like the Runaway Guard override: a malformed
 * remote value never throws and never blocks the runtime from starting.
 */
export function parsePromptSuggestionRemotePolicy(raw: unknown): PromptSuggestionRemotePolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const killSwitch = record.kill_switch ?? record.killSwitch;
  const sampleRate = record.sample_rate ?? record.sampleRate;
  return {
    ...(typeof killSwitch === 'boolean' ? { killSwitch } : {}),
    ...(typeof sampleRate === 'number' &&
    Number.isFinite(sampleRate) &&
    sampleRate >= 0 &&
    sampleRate <= 1
      ? { sampleRate }
      : {}),
  };
}
