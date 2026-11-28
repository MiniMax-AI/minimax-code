import type * as acp from '@agentclientprotocol/sdk';

import { resolveTuiDefaultEffort } from '../application/model-effort.js';
import {
  formatTuiPermissionMode,
  MINIMAX_CODE_PERMISSION_MODES,
  type TuiPermissionMode,
} from '../application/permission-mode.js';
import type { TuiModel, TuiSession, TuiSessionUsage } from '../runtime/port.js';
import { modelSupportsVariant } from './model-selection.js';
import type { TuiAcpRuntime } from './runtime.js';

export const ACP_MODE_DEFAULT = 'default';
export const ACP_MODE_PLAN = 'plan';
export const ACP_CONFIG_PERMISSION_MODE = 'permissionMode';
export const ACP_CONFIG_MODEL = 'model';
export const ACP_CONFIG_THINKING_EFFORT = 'thinkingEffort';

export interface TuiAcpSessionControlState {
  readonly modes: acp.SessionModeState;
  readonly configOptions: acp.SessionConfigOption[];
}

export interface TuiAcpSessionControlStateOptions {
  /**
   * False while session/new has only reserved the ID: the Runtime has no such Session yet, so
   * models come from the global roster and the reserved Session carries any buffered choice.
   */
  readonly persisted?: boolean;
}

export async function getTuiAcpSessionControlState(
  runtime: TuiAcpRuntime,
  session: TuiSession,
  options: TuiAcpSessionControlStateOptions = {},
): Promise<TuiAcpSessionControlState> {
  const persisted = options.persisted ?? true;
  const [planCapabilities, permissionMode, models] = await Promise.all([
    runtime.getPlanModeCapabilities().catch(() => ({ entryEnabled: false })),
    runtime.getPermissionMode().catch(() => undefined),
    (persisted ? runtime.listModels(session.sessionId) : runtime.listModels()).catch(
      () => [] as TuiModel[],
    ),
  ]);
  return {
    modes: modeState(session, planCapabilities.entryEnabled),
    configOptions: configOptions(session, permissionMode, models),
  };
}

export function modeState(session: TuiSession, planEntryEnabled = true): acp.SessionModeState {
  return {
    currentModeId: session.interactionMode === 'plan' ? ACP_MODE_PLAN : ACP_MODE_DEFAULT,
    availableModes: [
      {
        id: ACP_MODE_DEFAULT,
        name: 'Default',
        description: 'Work normally with the configured tools and permission policy.',
      },
      ...(planEntryEnabled || session.interactionMode === 'plan'
        ? [
            {
              id: ACP_MODE_PLAN,
              name: 'Plan',
              description: 'Research and prepare an implementation plan before making changes.',
            },
          ]
        : []),
    ],
  };
}

export function configOptions(
  session: TuiSession,
  permissionMode: TuiPermissionMode | undefined,
  models: readonly TuiModel[],
): acp.SessionConfigOption[] {
  const options: acp.SessionConfigOption[] = [];
  const permissionOption = permissionModeOption(permissionMode);
  if (permissionOption) options.push(permissionOption);
  const modelOption = sessionModelOption(session, models);
  if (modelOption) options.push(modelOption);
  const effortOption = thinkingEffortOption(session, models);
  if (effortOption) options.push(effortOption);
  return options;
}

export function parseModelConfigValue(value: string): {
  providerId: string;
  modelId: string;
  variant?: string;
} {
  const [prefix, provider, model, variantKind, variant, ...extra] = value.split(':');
  if (
    prefix !== 'm' ||
    !provider ||
    !model ||
    (variantKind !== 'u' && variantKind !== 'v') ||
    (variantKind === 'u' && variant !== undefined) ||
    (variantKind === 'v' && variant === undefined) ||
    extra.length > 0
  ) {
    throw new Error(`Invalid model config value: ${value}`);
  }
  return {
    providerId: decodeURIComponent(provider),
    modelId: decodeURIComponent(model),
    ...(variantKind === 'v' ? { variant: decodeURIComponent(variant ?? '') } : {}),
  };
}

export function modelConfigValue(selection: {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
}): string {
  const prefix = [
    'm',
    encodeURIComponent(selection.providerId),
    encodeURIComponent(selection.modelId),
  ];
  return selection.variant === undefined
    ? [...prefix, 'u'].join(':')
    : [...prefix, 'v', encodeURIComponent(selection.variant)].join(':');
}

export function usageUpdate(
  snapshot: Awaited<ReturnType<TuiAcpRuntime['getContextSnapshot']>>,
  usage: TuiSessionUsage,
): acp.UsageUpdate | undefined {
  const context = snapshot.contextUsage;
  if (!context || context.contextWindowTokens <= 0) return undefined;
  const costUsd = usage.summary?.costUsd;
  return {
    used: context.usedTokens,
    size: context.contextWindowTokens,
    ...(costUsd === undefined
      ? {}
      : {
          cost: {
            amount: costUsd,
            currency: 'USD',
          },
        }),
  };
}

function permissionModeOption(
  permissionMode: TuiPermissionMode | undefined,
): acp.SessionConfigOption | undefined {
  const current = MINIMAX_CODE_PERMISSION_MODES.find((mode) => mode === permissionMode);
  if (!current) return undefined;
  return {
    type: 'select',
    id: ACP_CONFIG_PERMISSION_MODE,
    name: 'Permission mode',
    description: 'Controls how MiniMax Code handles tool permission requests in this process.',
    category: '_permission',
    currentValue: current,
    options: MINIMAX_CODE_PERMISSION_MODES.map((mode) => ({
      value: mode,
      name: formatTuiPermissionMode(mode),
    })),
    _meta: { 'minimax-code/scope': 'process' },
  };
}

function sessionModelOption(
  session: TuiSession,
  models: readonly TuiModel[],
): acp.SessionConfigOption | undefined {
  const values = uniqueModelValues(models);
  if (values.length === 0) return undefined;
  const persistedSelection = selectedModel(session, models);
  if (
    persistedSelection &&
    !values.some(
      ({ selection }) => modelConfigValue(selection) === modelConfigValue(persistedSelection),
    )
  ) {
    return undefined;
  }
  const selected = persistedSelection ?? values[0]?.selection;
  if (!selected) return undefined;
  return {
    type: 'select',
    id: ACP_CONFIG_MODEL,
    name: 'Model',
    description: 'Selects the model used by subsequent turns in this Session.',
    category: 'model',
    currentValue: modelConfigValue(selected),
    options: values.map(({ selection, name }) => ({
      value: modelConfigValue(selection),
      name,
    })),
  };
}

function thinkingEffortOption(
  session: TuiSession,
  models: readonly TuiModel[],
): acp.SessionConfigOption | undefined {
  const selected = selectedModel(session, models);
  if (!selected) return undefined;
  const model = models.find(
    (candidate) =>
      candidate.providerId === selected.providerId &&
      candidate.modelId === selected.modelId &&
      modelSupportsVariant(candidate, selected.variant),
  );
  const efforts = model?.effortOptions ?? [];
  if (efforts.length === 0) return undefined;
  const persistedEffort = session.model?.thinking?.effort;
  if (persistedEffort && !efforts.includes(persistedEffort)) return undefined;
  const current = persistedEffort ?? resolveTuiDefaultEffort(model);
  if (!current) return undefined;
  return {
    type: 'select',
    id: ACP_CONFIG_THINKING_EFFORT,
    name: 'Thinking effort',
    description: 'Controls the reasoning effort for the selected model in this Session.',
    category: 'thought_level',
    currentValue: current,
    options: efforts.map((effort) => ({ value: effort, name: labelEffort(effort) })),
  };
}

function uniqueModelValues(models: readonly TuiModel[]): Array<{
  readonly selection: {
    readonly providerId: string;
    readonly modelId: string;
    readonly variant?: string;
  };
  readonly name: string;
}> {
  const seen = new Set<string>();
  const values = [];
  for (const model of models) {
    const variants = model.supportedVariants?.length
      ? model.supportedVariants
      : [model.variant].filter((variant): variant is string => variant !== undefined);
    const selections: Array<{ providerId: string; modelId: string; variant?: string }> =
      variants.length > 0
        ? variants.map((variant) => ({
            providerId: model.providerId,
            modelId: model.modelId,
            variant,
          }))
        : [{ providerId: model.providerId, modelId: model.modelId }];
    for (const selection of selections) {
      const value = modelConfigValue(selection);
      if (seen.has(value)) continue;
      seen.add(value);
      values.push({
        selection,
        name: `${model.displayName ?? model.modelId}${selection.variant ? ` · ${selection.variant}` : ''}`,
      });
    }
  }
  return values;
}

function selectedModel(
  session: TuiSession,
  models: readonly TuiModel[],
): { providerId: string; modelId: string; variant?: string } | undefined {
  if (session.model?.providerId && session.model.modelId) {
    return {
      providerId: session.model.providerId,
      modelId: session.model.modelId,
      ...(session.model.variant !== undefined ? { variant: session.model.variant } : {}),
    };
  }
  const selected = models.find((model) => model.selected);
  return selected
    ? {
        providerId: selected.providerId,
        modelId: selected.modelId,
        ...(selected.variant !== undefined ? { variant: selected.variant } : {}),
      }
    : undefined;
}

function labelEffort(value: string): string {
  return value.length > 0 ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}
