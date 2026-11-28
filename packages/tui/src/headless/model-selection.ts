import { normalizeTuiEffortOptions } from '../application/model-effort.js';
import type {
  TuiAdvisorSelection,
  TuiModel,
  TuiModelSelection,
  TuiSession,
} from '../runtime/port.js';
import { TuiExecError } from './exit-policy.js';

/**
 * Variants Runtime reads as "thinking is off" rather than as a model identity.
 * `''` cannot reach here through `--model` because an empty suffix is rejected
 * while parsing, but it stays listed because the Session echo and the catalog
 * entry both use it.
 */
const THINKING_OFF_VARIANTS: ReadonlySet<string> = new Set(['none-thinking', '']);

const MODEL_SYNTAX = '--model must use provider/model or provider/model#variant.';
const ADVISOR_SYNTAX = '--advisor must use provider/model or off.';

export interface HeadlessModelReference {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
}

export interface HeadlessModelCatalogReader {
  listModels(sessionId?: string): Promise<TuiModel[]>;
}

export interface HeadlessModelSelectionInput {
  /** Raw `--model` value, already trimmed by the invocation layer. */
  readonly model?: string;
  /** Raw `--effort` value, already trimmed and rejected when blank. */
  readonly effort?: string;
  readonly session: TuiSession;
  readonly runtime: HeadlessModelCatalogReader;
}

export function parseHeadlessModelOverride(value: string): HeadlessModelReference {
  const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw invocationError(MODEL_SYNTAX);
  const providerId = value.slice(0, slash);
  const modelAndVariant = value.slice(slash + 1);
  const hash = modelAndVariant.lastIndexOf('#');
  const modelId = hash > 0 ? modelAndVariant.slice(0, hash) : modelAndVariant;
  const variant = hash > 0 ? modelAndVariant.slice(hash + 1) : undefined;
  if (!providerId || !modelId || (hash > 0 && !variant)) throw invocationError(MODEL_SYNTAX);
  return { providerId, modelId, ...(variant ? { variant } : {}) };
}

/**
 * `--advisor` takes the `--model` syntax without `#variant`, because an advisor stores only a
 * model, its effort and its window; `off` in any case switches it off and keeps that model.
 */
export function parseAdvisorOverride(value: string): TuiAdvisorSelection {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'off') return { enabled: false };
  const slash = trimmed.indexOf('/');
  if (slash < 1 || slash === trimmed.length - 1) throw invocationError(ADVISOR_SYNTAX);
  const modelId = trimmed.slice(slash + 1);
  if (modelId.includes('#')) {
    throw invocationError('--advisor does not take a #variant; use provider/model or off.');
  }
  return { enabled: true, providerId: trimmed.slice(0, slash), modelId };
}

/**
 * Builds the per-Turn model selection for one headless Run.
 *
 * `variant` and `effort` are separate concepts and stay separate here:
 * `#variant` is part of the model identity, while `--effort` is the per-Turn
 * reasoning strength. Every explicit effort is validated against the target
 * model's declared `effortOptions` before the Turn starts, so Runtime never
 * receives a level it would quietly replace with its own default.
 */
export async function resolveHeadlessModelSelection(
  input: HeadlessModelSelectionInput,
): Promise<TuiModelSelection | undefined> {
  const requested = input.model ? parseHeadlessModelOverride(input.model) : undefined;
  const effort = input.effort;
  /**
   * Without `--effort` there is nothing to validate, so `--model p/m#variant`
   * keeps its original meaning for every suffix. A suffix that happens to spell
   * an effort level stays a variant: Runtime reads it as a model identity,
   * suppresses the catalog default, and runs at its own default strength. That
   * silent downgrade is long-standing behaviour callers may already depend on,
   * so it is left intact rather than turned into a startup failure. `--effort`
   * is the explicit path that is checked and never downgraded.
   */
  if (effort === undefined) return requested ? { ...requested } : undefined;

  const catalog = await readModelCatalog(input, effort);
  const base = requested ?? defaultModelReference(input.session, catalog);
  if (!base) {
    throw invocationError(
      '--effort could not resolve a model. Pass --model provider/model, or select a model for this Session first.',
    );
  }
  const target = catalog.find(
    (candidate) => candidate.providerId === base.providerId && candidate.modelId === base.modelId,
  );
  const effortOptions = normalizeTuiEffortOptions(target?.effortOptions);
  const reference = `${base.providerId}/${base.modelId}`;
  /**
   * `--model p/m` carries no variant, but the catalog entry still states the
   * variant that model runs with. Runtime drops the effort whenever that
   * effective variant means thinking off, so the check reads the effective
   * variant rather than only the one the caller typed.
   */
  const effectiveVariant = base.variant ?? target?.variant;
  if (effectiveVariant !== undefined && THINKING_OFF_VARIANTS.has(effectiveVariant)) {
    throw invocationError(
      thinkingOffMessage({ requested, reference, effort, effectiveVariant, target }),
    );
  }
  if (!target) {
    throw invocationError(
      `${reference} is not in this Session's model list, so --effort ${effort} cannot be validated. Check the provider and model id.`,
    );
  }
  if (effortOptions.length === 0) {
    throw invocationError(
      `${reference} does not support reasoning effort selection, so --effort ${effort} cannot be applied.`,
    );
  }
  if (!effortOptions.includes(effort)) {
    throw invocationError(
      `--effort ${effort} is not available for ${reference}. Available levels: ${effortOptions.join(', ')}.`,
    );
  }
  return {
    providerId: base.providerId,
    modelId: base.modelId,
    ...(base.variant === undefined ? {} : { variant: base.variant }),
    thinking: { effort },
  };
}

/**
 * Thinking-off reaches a Run three ways, and each one has a different fix:
 * the caller typed the variant, the Session carries it, or the model simply
 * runs that way by default. A `switchable` model can be turned back on with
 * `#thinking`; a forced-off model cannot, so it is not offered that advice.
 */
function thinkingOffMessage(input: {
  readonly requested: HeadlessModelReference | undefined;
  readonly reference: string;
  readonly effort: string;
  readonly effectiveVariant: string;
  readonly target: TuiModel | undefined;
}): string {
  const { requested, reference, effort, effectiveVariant, target } = input;
  if (requested?.variant !== undefined) {
    return `--effort cannot be combined with the thinking-off variant "#${effectiveVariant}". Drop one of them.`;
  }
  if (!requested) {
    return `--effort cannot be applied because this Session runs the thinking-off variant "#${effectiveVariant}". Switch the Session model, or pass --model with a thinking-capable variant.`;
  }
  const remedy =
    target?.thinkingConfig?.mode === 'switchable'
      ? ` Pass --model ${reference}#thinking to turn thinking on.`
      : '';
  return `${reference} runs with thinking off by default, so --effort ${effort} would be discarded.${remedy}`;
}

/**
 * The roster is only read when a decision depends on it, which is exactly when
 * `--effort` is given. That level cannot be validated without the roster, so a
 * roster failure fails the Run rather than letting an unchecked level through.
 * A plain `--model` never reaches here, so it keeps working while the roster is
 * unavailable.
 */
async function readModelCatalog(
  input: HeadlessModelSelectionInput,
  effort: string,
): Promise<readonly TuiModel[]> {
  try {
    return await input.runtime.listModels(input.session.sessionId);
  } catch (error) {
    throw new TuiExecError(
      'runtime',
      `--effort ${effort} could not be validated because the model roster is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * Mirrors the product rule: a Session-scoped roster selection wins, then the
 * Session echo. The active variant travels with it, because a bare `--effort`
 * must change the reasoning strength without rewriting the model identity.
 */
function defaultModelReference(
  session: TuiSession,
  catalog: readonly TuiModel[],
): HeadlessModelReference | undefined {
  const selected = catalog.find((candidate) => candidate.selected === true);
  if (selected) {
    return {
      providerId: selected.providerId,
      modelId: selected.modelId,
      ...(selected.variant === undefined ? {} : { variant: selected.variant }),
    };
  }
  const echo = session.model;
  if (echo?.providerId && echo.modelId) {
    return {
      providerId: echo.providerId,
      modelId: echo.modelId,
      ...(echo.variant === undefined ? {} : { variant: echo.variant }),
    };
  }
  return undefined;
}

function invocationError(message: string): TuiExecError {
  return new TuiExecError('invocation', message);
}
