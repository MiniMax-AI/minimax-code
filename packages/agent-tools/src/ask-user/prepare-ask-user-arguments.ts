import { logger } from '@mavis/shared/local-runtime-logging/logger';

export interface PreparedAskUserOption {
  id?: string;
  label: string;
  description?: string;
  image?: { src: string; alt?: string; caption?: string };
  recommended?: boolean;
}

export interface PreparedAskUserStep {
  id?: string;
  header?: string;
  question: string;
  description?: string;
  image?: { src: string; alt?: string; caption?: string };
  options: PreparedAskUserOption[];
  selectionMode?: 'single' | 'multiple';
}

export type PreparedAskUserArguments = {
  mode?: 'questionnaire';
  async?: boolean;
  title?: string;
  steps: PreparedAskUserStep[];
};

const TOP_LEVEL_STEP_KEYS = [
  'id',
  'header',
  'question',
  'description',
  'image',
  'options',
  'selectionMode',
  'multiSelect',
] as const;

/**
 * Normalize legacy provider wrappers immediately before schema validation.
 * Some provider adapters wrap repeated payloads as `steps.item` /
 * `options.item`. Invalid wrappers remain untouched so validation fails closed.
 */
export function prepareAskUserArguments(args: unknown): PreparedAskUserArguments {
  if (!isRecord(args)) return args as PreparedAskUserArguments;

  let prepared = stripRetiredAskUserFields(args);
  if (typeof prepared.question === 'string' && prepared.options !== undefined) {
    const questionnaire: Record<string, unknown> = { ...prepared };
    const step: Record<string, unknown> = {};
    for (const key of TOP_LEVEL_STEP_KEYS) {
      if (!(key in questionnaire)) continue;
      step[key] = questionnaire[key];
      delete questionnaire[key];
    }
    questionnaire.steps = [step];
    prepared = questionnaire;
  }

  const legacySteps = unwrapLegacyItems(prepared.steps);
  const steps =
    legacySteps ??
    (Array.isArray(prepared.steps) && prepared.steps.every(isRecord)
      ? prepared.steps
      : isRecord(prepared.steps) && typeof prepared.steps.question === 'string'
        ? [prepared.steps]
        : undefined);
  if (steps) {
    const normalizedSteps = steps.map(normalizeLegacyAskUserStep);
    const changed =
      legacySteps !== undefined ||
      !Array.isArray(prepared.steps) ||
      normalizedSteps.some((step, index) => step !== steps[index]);
    if (changed) {
      prepared = {
        ...prepared,
        steps: normalizedSteps,
      };
    }
  }

  return prepared as PreparedAskUserArguments;
}

/**
 * `requiresExplicitResponse` was replaced by `async`. The schema forbids unknown
 * properties, so models trained on the old contract would fail validation;
 * drop the field instead. It carries no meaning any more: an omitted `async`
 * already waits for the reply, which is what `requiresExplicitResponse: true`
 * asked for. Logged so a model still sending the retired field is visible.
 */
function stripRetiredAskUserFields(args: Record<string, unknown>): Record<string, unknown> {
  if (!('requiresExplicitResponse' in args)) return args;
  const rest = { ...args };
  delete rest.requiresExplicitResponse;
  logger.info(
    {
      reason: 'retired_field_stripped',
      field: 'requiresExplicitResponse',
      value: String(args.requiresExplicitResponse),
      asyncProvided: 'async' in args,
    },
    'ask_user retired argument stripped before validation',
  );
  return rest;
}

function unwrapLegacyItems(value: unknown): Record<string, unknown>[] | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !('item' in value)) {
    return undefined;
  }
  const items = Array.isArray(value.item) ? value.item : [value.item];
  return items.every(isRecord) ? items : undefined;
}

function normalizeLegacyAskUserStep(step: Record<string, unknown>): Record<string, unknown> {
  const legacyOptions = unwrapLegacyItems(step.options);
  const options =
    legacyOptions ??
    (Array.isArray(step.options) && step.options.every(isRecord) ? step.options : undefined);
  const normalizedOptions = options?.map(normalizeLegacyAskUserOption);
  const selectionMode = normalizeSelectionMode(step.multiSelect);
  const optionsChanged =
    normalizedOptions !== undefined &&
    (legacyOptions !== undefined ||
      normalizedOptions.some((option, index) => option !== options?.[index]));
  if (!optionsChanged && selectionMode === undefined) return step;

  const prepared: Record<string, unknown> = { ...step };
  if (optionsChanged) prepared.options = normalizedOptions;
  if (selectionMode !== undefined) {
    if (prepared.selectionMode === undefined) prepared.selectionMode = selectionMode;
    delete prepared.multiSelect;
  }
  return prepared;
}

function normalizeSelectionMode(value: unknown): 'single' | 'multiple' | undefined {
  if (value === false || value === 'false') return 'single';
  if (value === true || value === 'true') return 'multiple';
  return undefined;
}

function normalizeLegacyAskUserOption(option: Record<string, unknown>): Record<string, unknown> {
  if (option.recommended === 'true') return { ...option, recommended: true };
  if (option.recommended === 'false') return { ...option, recommended: false };
  return option;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
