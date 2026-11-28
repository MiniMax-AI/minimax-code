import type { Api, Model } from '@earendil-works/pi-ai';
import { ThinkingLevel, type IModelRef } from '@mavis/protocol';
import { parseProviderId } from '../resolution/model-key.js';
import {
  isMiniMaxM3ModelId,
  isMiniMaxM3ThinkingMode,
  resolveMiniMaxM3ThinkingProtocol,
} from '../resolution/model-ref.js';
import { readSelectedThinkingEffort } from '../catalog/model-selection.js';
import { isRecord } from './payload-shape.js';

export const OPENPLATFORM_THINKING_VARIANTS_CAPABILITY = 'openplatform_thinking_variants';

export interface OpenPlatformThinkingVariants {
  thinking?: Record<string, unknown>;
  'none-thinking'?: Record<string, unknown>;
}

function cloneThinkingPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return { ...value };
}

function patchMiniMaxM3Effort(
  payload: Record<string, unknown>,
  model: Model<Api>,
  effort: 'on' | 'off',
): Record<string, unknown> | undefined {
  if (model.api === 'openai-responses') return patchMiniMaxM3Responses(payload, effort);
  if (model.api === 'openai-completions' || model.api === 'openai-chat') {
    return patchMiniMaxM3Completions(payload, effort);
  }
  if (model.api === 'anthropic-messages') return patchMiniMaxM3Anthropic(payload, effort);
  return undefined;
}

function patchMiniMaxM3Responses(
  payload: Record<string, unknown>,
  effort: 'on' | 'off',
): Record<string, unknown> {
  const patch = resolveMiniMaxM3ThinkingProtocol('openai-responses', effort);
  const reasoningPatch = isRecord(patch.reasoning) ? patch.reasoning : {};
  payload.reasoning = {
    ...(isRecord(payload.reasoning) ? payload.reasoning : {}),
    ...reasoningPatch,
  };
  return payload;
}

function patchMiniMaxM3Completions(
  payload: Record<string, unknown>,
  effort: 'on' | 'off',
): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.messages)) return undefined;
  const patch = resolveMiniMaxM3ThinkingProtocol('openai-completions', effort);
  payload.thinking = isRecord(patch.thinking) ? { ...patch.thinking } : {};
  delete payload.reasoning_effort;
  return payload;
}

function patchMiniMaxM3Anthropic(
  payload: Record<string, unknown>,
  effort: 'on' | 'off',
): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.messages)) return undefined;
  const patch = resolveMiniMaxM3ThinkingProtocol('anthropic-messages', effort);
  payload.thinking = isRecord(patch.thinking) ? { ...patch.thinking } : {};
  const outputConfig = isRecord(payload.output_config) ? { ...payload.output_config } : {};
  delete outputConfig.effort;
  if (Object.keys(outputConfig).length > 0) payload.output_config = outputConfig;
  else delete payload.output_config;
  return payload;
}

function getOpenPlatformThinkingVariants(
  modelRef: IModelRef | undefined,
): OpenPlatformThinkingVariants | undefined {
  const capabilities = modelRef?.capabilities as Record<string, unknown> | undefined;
  const raw = capabilities?.[OPENPLATFORM_THINKING_VARIANTS_CAPABILITY];
  if (!isRecord(raw)) return undefined;
  const thinking = cloneThinkingPayload(raw.thinking);
  const noneThinking = cloneThinkingPayload(raw['none-thinking']);
  if (!thinking && !noneThinking) return undefined;
  return {
    ...(thinking ? { thinking } : {}),
    ...(noneThinking ? { 'none-thinking': noneThinking } : {}),
  };
}

export function buildOpenPlatformThinkingPatcher(modelRef: IModelRef | undefined) {
  const level = modelRef?.thinking_level;
  const thinkingOn = level !== undefined && level !== ThinkingLevel.OFF;
  const variants = getOpenPlatformThinkingVariants(modelRef);
  const selectedEffort = readSelectedThinkingEffort(
    modelRef?.capabilities as Record<string, unknown> | undefined,
  );
  const miniMaxM3Effort =
    isMiniMaxM3ModelId(modelRef?.model_id) && isMiniMaxM3ThinkingMode(selectedEffort)
      ? selectedEffort
      : undefined;

  return function patchOpenPlatformThinking(
    payload: unknown,
    model: Model<Api>,
  ): unknown | undefined {
    if (!isRecord(payload)) return undefined;
    if (miniMaxM3Effort) return patchMiniMaxM3Effort(payload, model, miniMaxM3Effort);
    if (!variants) return undefined;

    const thinking = thinkingOn ? variants.thinking : variants['none-thinking'];
    if (!thinking) return undefined;
    if (model.api !== 'anthropic-messages') {
      if (isMiniMaxM3ModelId(modelRef?.model_id)) {
        return patchMiniMaxM3Variant(payload, model, thinkingOn);
      }
      return undefined;
    }
    return patchMessagesApiVariant({ payload, model, thinking, thinkingOn, selectedEffort });
  };
}

function patchMiniMaxM3Variant(
  payload: Record<string, unknown>,
  model: Model<Api>,
  thinkingOn: boolean,
): Record<string, unknown> | undefined {
  const effort = thinkingOn ? 'on' : 'off';
  if (model.api === 'openai-responses') return patchMiniMaxM3Responses(payload, effort);
  if (model.api === 'openai-completions' || model.api === 'openai-chat') {
    return patchMiniMaxM3Completions(payload, effort);
  }
  return undefined;
}

type MessagesApiVariantPatchOptions = {
  payload: Record<string, unknown>;
  model: Model<Api>;
  thinking?: Record<string, unknown>;
  thinkingOn: boolean;
  selectedEffort?: string;
};

type MessagesApiOutputConfigOptions = Pick<
  MessagesApiVariantPatchOptions,
  'payload' | 'model' | 'thinkingOn' | 'selectedEffort'
>;

function shouldPreserveProviderEffort(options: {
  model: Model<Api>;
  currentEffort: unknown;
  configuredEffort: string | undefined;
}): boolean {
  if (options.configuredEffort) return false;
  if (parseProviderId(options.model.provider)?.source !== 'custom_provider') return false;
  if (typeof options.currentEffort !== 'string') return false;
  return Object.values(options.model.thinkingLevelMap ?? {}).includes(options.currentEffort);
}

function patchMessagesApiOutputConfig(options: MessagesApiOutputConfigOptions): void {
  const { payload, model, thinkingOn, selectedEffort } = options;
  const outputConfig = isRecord(payload.output_config) ? { ...payload.output_config } : {};
  const configuredEffort = thinkingOn ? selectedEffort : undefined;
  if (configuredEffort) outputConfig.effort = configuredEffort;
  else if (
    !shouldPreserveProviderEffort({
      model,
      currentEffort: outputConfig.effort,
      configuredEffort,
    })
  ) {
    delete outputConfig.effort;
  }
  if (Object.keys(outputConfig).length > 0) payload.output_config = outputConfig;
  else delete payload.output_config;
}

function patchMessagesApiVariant(
  options: MessagesApiVariantPatchOptions,
): Record<string, unknown> | undefined {
  const { payload, thinking } = options;
  if (!Array.isArray(payload.messages)) return undefined;
  if (thinking) payload.thinking = { ...thinking };
  patchMessagesApiOutputConfig(options);
  return payload;
}
