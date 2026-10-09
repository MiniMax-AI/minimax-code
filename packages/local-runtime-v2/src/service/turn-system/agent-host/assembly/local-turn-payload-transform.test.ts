import { streamSimple } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { LocalModelResolver } from '../../../model-system/resolution/local-model-resolver.js';
import { modelRefForModel } from '../../../model-system/resolution/model-ref.js';
import type { LocalModelConfig } from '../../../model-system/contracts.js';
import { buildLocalRequestPayloadTransform } from './local-turn-payload-transform.js';

// Mirrors the bundled MiniMax catalog entries that matter for thinking.
const M31_FLASH = {
  name: 'M3.1-Flash-Preview',
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 512_000, output: 128_000 },
  thinking: {
    effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'default',
  },
  thinking_config: { mode: 'forced_on' },
  variants: {
    'none-thinking': { thinking: { type: 'disabled' } },
    thinking: { thinking: { type: 'adaptive' } },
  },
} as unknown as LocalModelConfig;

const M3 = {
  name: 'M3',
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 1_000_000, output: 128_000 },
  thinking_config: { mode: 'forced_on' },
  variants: {
    'none-thinking': { thinking: { type: 'disabled' } },
    thinking: { thinking: { type: 'adaptive' } },
  },
} as unknown as LocalModelConfig;

/** Resolve an API-key MiniMax model and capture the request body pi-ai actually sends. */
async function captureWireBody(input: {
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfig: LocalModelConfig;
  readonly effort?: string;
  readonly minimaxModelSource?: string;
}) {
  const modelRef = modelRefForModel(input.provider, input.modelId, input.modelConfig, {
    ...(input.effort ? { thinking: { effort: input.effort } } : {}),
  } as never);
  const agentConfig = {
    system_prompt: 'system',
    agent_id: 'agent',
    model: modelRef,
    tools: [],
    skills: [],
  } as never;
  const resolver = new LocalModelResolver({
    providerConfig: { minimax: { models: { [input.modelId]: input.modelConfig } } } as never,
    byokConfigGetter: () =>
      ({
        ...(input.minimaxModelSource ? { minimaxModelSource: input.minimaxModelSource } : {}),
        minimax_api: { apiKey: 'k', baseURL: 'https://byok.invalid/anthropic' },
      }) as never,
  });
  const llm = await resolver.resolveModel({ sessionId: 's', turnId: 't', agentConfig });
  expect(llm.model.provider).toBe('minimax_api');
  expect(llm.managedProvider).not.toBe(true);
  let body: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: unknown, init: { body?: unknown }) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response('stop here', { status: 500 });
  }) as unknown as typeof fetch;
  const onPayload = buildLocalRequestPayloadTransform(
    { agentConfig, llm, sessionId: 's', signal: new AbortController().signal },
    {},
  );
  const stream = streamSimple(
    llm.model as never,
    { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
    {
      apiKey: 'k',
      reasoning: llm.thinkingLevel ?? undefined,
      fetch: fetchImpl,
      onPayload,
      maxRetries: 0,
    } as never,
  );
  for await (const _event of stream) {
    // Drain until the stubbed provider error ends the stream.
  }
  expect(body).toBeDefined();
  return body!;
}

describe('API-key MiniMax thinking effort', () => {
  it.each(['high', 'low', 'xhigh', 'max'])(
    'keeps --effort %s on the minimax_api wire request',
    async (effort) => {
      const body = await captureWireBody({
        provider: 'minimax_api',
        modelId: 'MiniMax-M3.1-Flash-Preview',
        modelConfig: M31_FLASH,
        effort,
      });
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort });
    },
  );

  it('keeps --effort when a MiniMax model is routed through the API key source', async () => {
    const body = await captureWireBody({
      provider: 'minimax',
      modelId: 'MiniMax-M3.1-Flash-Preview',
      modelConfig: M31_FLASH,
      effort: 'high',
      minimaxModelSource: 'minimax_api_key',
    });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('sends no effort when none was selected (default)', async () => {
    const body = await captureWireBody({
      provider: 'minimax_api',
      modelId: 'MiniMax-M3.1-Flash-Preview',
      modelConfig: M31_FLASH,
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body).not.toHaveProperty('output_config');
  });

  it('sends no effort for a model without effort levels', async () => {
    const body = await captureWireBody({
      provider: 'minimax_api',
      modelId: 'MiniMax-M3',
      modelConfig: M3,
      effort: 'high',
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body).not.toHaveProperty('output_config');
  });
});
