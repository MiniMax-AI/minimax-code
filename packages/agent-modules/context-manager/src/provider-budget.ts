import { DEFAULT_CONTEXT_MANAGER_SETTINGS } from './settings.js';

const PROVIDER_INPUT_RATIO = 0.95;
/** Integer percent keeps the trigger exact (0.95 is not exact in binary floating point). */
const AUTOMATIC_TRIGGER_PERCENT = 95;

export function resolveDynamicMaxTokens(input: {
  readonly contextWindow: number;
  readonly configuredMaxTokens: number;
  readonly estimatedContextTokens: number;
}): number {
  const { contextWindow, configuredMaxTokens, estimatedContextTokens } = input;
  if (!(contextWindow > 0) || !(configuredMaxTokens > 0)) return configuredMaxTokens;
  const remaining =
    contextWindow - estimatedContextTokens - DEFAULT_CONTEXT_MANAGER_SETTINGS.safetyMarginTokens;
  return Math.min(configuredMaxTokens, Math.max(outputFloor(configuredMaxTokens), remaining));
}

export function resolveCompactionTokenBudget(input: {
  readonly contextWindow: number;
  readonly configuredMaxOutputTokens: number;
  /**
   * User `contextManagement.compactionTriggerAt`. It can only lower the
   * automatic trigger; invalid values are ignored like an unset setting.
   */
  readonly compactionTriggerAt?: number | undefined;
}): { readonly providerInputLimit: number; readonly automaticTriggerAt: number } {
  const configuredOutput = positive(input.configuredMaxOutputTokens);
  const { reserveTokens, safetyMarginTokens } = DEFAULT_CONTEXT_MANAGER_SETTINGS;
  // Admission mirrors resolveDynamicMaxTokens: a real Provider request shrinks
  // its output budget down to the dynamic floor when input is large, so the
  // hard input limit reserves the floor instead of the full configured output.
  // Reserving the full output here rejects requests the Provider would accept
  // (e.g. 200K-window models with 128K configured output collapsed the input
  // budget to ~70K and wedged sessions whose fixed prompt exceeded it).
  const effectiveOutput = outputFloor(configuredOutput);
  const providerInputLimit = Math.max(
    1,
    Math.min(
      Math.floor(input.contextWindow * PROVIDER_INPUT_RATIO),
      input.contextWindow - reserveTokens,
      input.contextWindow - effectiveOutput - safetyMarginTokens,
    ),
  );
  // The automatic trigger reserves the configured output, capped at a quarter
  // of the window, and compacts at 95% of the remainder. Large windows then
  // start compaction while the main and checkpoint requests still have their
  // configured output room; small windows are not collapsed by a large output
  // limit. providerInputLimit stays the upper bound.
  const outputReserve = Math.min(configuredOutput, Math.floor(input.contextWindow / 4));
  const outputReservedTrigger = Math.floor(
    ((input.contextWindow - outputReserve) * AUTOMATIC_TRIGGER_PERCENT) / 100,
  );
  const builtInTrigger = Math.min(providerInputLimit, Math.max(1, outputReservedTrigger));
  const configuredTrigger = resolveConfiguredCompactionTrigger(
    input.compactionTriggerAt,
    input.contextWindow,
  );
  return {
    providerInputLimit,
    automaticTriggerAt:
      configuredTrigger === undefined ? builtInTrigger : Math.min(builtInTrigger, configuredTrigger),
  };
}

/**
 * `compactionTriggerAt` accepts a window ratio in (0, 1] or an absolute token
 * count as an integer above 1. Anything else, such as 1.5, is invalid.
 */
export function isValidCompactionTriggerSetting(value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  return value <= 1 || Number.isSafeInteger(value);
}

/** Resolves the user setting to tokens, or undefined when it should be ignored. */
export function resolveConfiguredCompactionTrigger(
  value: number | undefined,
  contextWindow: number,
): number | undefined {
  if (value === undefined || !isValidCompactionTriggerSetting(value)) return undefined;
  if (value > 1) return value;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return Math.max(1, Math.floor(contextWindow * value));
}

function outputFloor(configuredMaxTokens: number): number {
  return Math.min(configuredMaxTokens, DEFAULT_CONTEXT_MANAGER_SETTINGS.reserveTokens);
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
