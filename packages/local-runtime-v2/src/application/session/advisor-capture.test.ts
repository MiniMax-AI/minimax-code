import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { PiTurnRunner, type PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import {
  createAgentRuntime,
  type AgentExtension,
  type TurnAssemblyCtx,
} from '@mavis/agent-runtime';
import { describe, expect, it } from 'vitest';

import type { LocalResolvedModelConfig } from '../../service/model-system/index.js';
import { AdvisorCaptureStore, createAdvisorExtension } from './advisor-capture.js';
import { createAdvisorTool } from './advisor-tool.js';

const SESSION_ID = 'session-capture';
const TURN_ID = 'turn-capture';
const BINDING = {
  providerId: 'provider-advisor',
  modelId: 'advisor-large',
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
};
const REQUEST_ONLY_REMINDER = '<system-reminder>request-only reminder</system-reminder>';

function model(id: string, provider: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'anthropic-messages',
    provider,
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

function response(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'provider-main',
    model: 'main-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

function scripted(responses: AssistantMessage[], contexts: Context[] = []): StreamFn {
  let index = 0;
  return (async (_model: Model<Api>, context: Context) => {
    contexts.push({
      ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
      messages: structuredClone(context.messages),
    });
    const next = responses[index++];
    if (!next) throw new Error(`unexpected provider call ${index}`);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: next });
    next.content.forEach((block, contentIndex) => {
      if (block.type !== 'toolCall') return;
      stream.push({ type: 'toolcall_start', contentIndex, partial: next });
      stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: next });
    });
    stream.push({ type: 'done', reason: next.stopReason as 'stop', message: next });
    return stream;
  }) as StreamFn;
}

/** A before-LLM hook that changes only the provider request, never canonical history. */
const requestOnlyReminder: AgentExtension = {
  id: 'request-only-reminder',
  init(api) {
    api.on('before_llm_call', (input) =>
      input.phase === 'initial'
        ? {
            type: 'replaceRequestMessages',
            reason: 'test reminder',
            messages: [
              ...input.messages,
              { role: 'user', content: REQUEST_ONLY_REMINDER, timestamp: 0 },
            ],
          }
        : undefined,
    );
  },
};

async function runTurn(
  mainResponses: AssistantMessage[],
  options: { ordinaryInput?: boolean } = {},
) {
  const store = new AdvisorCaptureStore();
  const advisorRequests: Context[] = [];
  const materialSeen: Record<string, boolean> = {};
  const userInputs: Record<string, string | undefined> = {};
  const advisorLlm: LocalResolvedModelConfig = {
    model: model('advisor-large', 'provider-advisor'),
    streamFn: scripted(
      [
        response([{ type: 'text', text: 'Advice one.' }], 'stop'),
        response([{ type: 'text', text: 'Advice two.' }], 'stop'),
      ],
      advisorRequests,
    ),
  };
  const tool = createAdvisorTool({
    captures: {
      read: (sessionId, turnId, toolCallId) => {
        const material = store.read(sessionId, turnId, toolCallId);
        materialSeen[toolCallId] = material !== undefined;
        userInputs[toolCallId] = material?.userInput;
        return material;
      },
    },
    resolveModel: async () => ({ agentConfig: {}, llm: advisorLlm }),
    buildPayloadTransform: () => undefined,
    recordUsage: async () => undefined,
  }) as unknown as RuntimeTool;
  const runtime = await createAgentRuntime({
    base: [requestOnlyReminder, createAdvisorExtension(store)],
  });
  const ctx: TurnAssemblyCtx = {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    agentName: 'mavis',
    workspaceDir: '/workspace',
    agentConfig: { advisor: BINDING },
    model: {},
    history: [],
    userInput: { text: 'Fix the parser' },
    sendsUserMessage: true,
  };
  const assembly = await runtime.assembleTurn(ctx);
  for (const handler of assembly.turnStartHandlers) {
    await handler(
      {
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        agentName: 'mavis',
        workspaceDir: '/workspace',
        history: [],
        userInput: { text: 'Fix the parser' },
        isOrdinaryInputTurn: options.ordinaryInput ?? true,
      },
      ctx,
    );
  }
  const mainRequests: Context[] = [];
  const writer: PiEventWriter = { pushRuntime: () => undefined, appendEvents: () => undefined };
  await new PiTurnRunner().runTurn({
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    workspaceDir: '/workspace',
    systemPrompt: 'MAIN SYSTEM PROMPT',
    userMessage: { text: 'Fix the parser' },
    llm: {
      model: model('main-model', 'provider-main'),
      streamFn: scripted(mainResponses, mainRequests),
    },
    eventWriter: writer,
    toolConfig: { tools: [tool], context: { sessionId: SESSION_ID, turnId: TURN_ID } },
    hooks: assembly.hooks,
  });
  const storeAfterRun = store.size;
  for (const handler of assembly.turnEndHandlers) {
    await handler(
      { sessionId: SESSION_ID, turnId: TURN_ID, agentName: 'mavis', workspaceDir: '/workspace' },
      ctx,
    );
  }
  return {
    advisorRequests,
    mainRequests,
    materialSeen,
    userInputs,
    storeAfterRun,
    storeAfterTurnEnd: store.size,
  };
}

function transcriptOf(context: Context | undefined): string {
  const content = context?.messages[0]?.content;
  return Array.isArray(content)
    ? content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    : String(content ?? '');
}

describe('advisor System Prompt guidance', () => {
  it('is contributed only for a Turn bound to an advisor model', async () => {
    const runtime = await createAgentRuntime({
      base: [createAdvisorExtension(new AdvisorCaptureStore())],
    });
    const assemble = (agentConfig: Record<string, unknown>) =>
      runtime.assembleTurn({
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        agentName: 'mavis',
        workspaceDir: '/workspace',
        agentConfig,
        model: {},
        history: [],
        userInput: { text: 'Fix the parser' },
        sendsUserMessage: true,
      });

    const bound = await assemble({ advisor: BINDING });
    const unbound = await assemble({});

    expect(bound.systemPromptPrefix).toMatch(/^<advisor>\n[\s\S]*<\/advisor>$/u);
    expect(bound.systemPromptPrefix).toContain('Call advisor BEFORE substantive work');
    expect(bound.systemPromptPrefix).toContain('When you believe the task is complete.');
    expect(unbound.systemPromptPrefix).toBe('');
  });
});

describe('advisor capture through AgentRuntime and PiTurnRunner', () => {
  it('forwards the prepared request view, including request-only rewrites, plus the current assistant message', async () => {
    const result = await runTurn([
      response(
        [
          { type: 'thinking', thinking: 'The tokenizer may be the culprit.' },
          { type: 'text', text: 'Let me get a second opinion.' },
          { type: 'toolCall', id: 'call-1', name: 'advisor', arguments: {} },
        ],
        'toolUse',
      ),
      response([{ type: 'text', text: 'Done.' }], 'stop'),
    ]);

    expect(result.advisorRequests).toHaveLength(1);
    const transcript = transcriptOf(result.advisorRequests[0]);
    expect(transcript).toContain('<system_prompt>\nMAIN SYSTEM PROMPT\n</system_prompt>');
    expect(transcript).toContain('Fix the parser');
    expect(transcript).toContain('request-only reminder');
    expect(transcript).toContain(
      '<prev_model_think>\nThe tokenizer may be the culprit.\n</prev_model_think>',
    );
    expect(transcript).toContain('Let me get a second opinion.');
    expect(transcript).toContain('<tool_call name="advisor">{}</tool_call>');
    // The main request offered no ask_user tool.
    expect(transcript).toContain('In this session the agent cannot ask the user anything');
    // The main model reads the advice as an ordinary tool result.
    expect(JSON.stringify(result.mainRequests[1]?.messages)).toContain('Advice one.');
  });

  it.each([
    ['an ordinary input Turn', true, 'Fix the parser'],
    ['a continuation', false, undefined],
  ])('hands the user input of %s to the call', async (_label, ordinaryInput, expected) => {
    const result = await runTurn(
      [
        response([{ type: 'toolCall', id: 'call-1', name: 'advisor', arguments: {} }], 'toolUse'),
        response([{ type: 'text', text: 'Done.' }], 'stop'),
      ],
      { ordinaryInput },
    );

    expect(result.userInputs).toEqual({ 'call-1': expected });
  });

  it('keys parallel advisor calls by tool call id and drops all material at Turn end', async () => {
    const result = await runTurn([
      response(
        [
          { type: 'toolCall', id: 'call-a', name: 'advisor', arguments: {} },
          { type: 'toolCall', id: 'call-b', name: 'advisor', arguments: {} },
        ],
        'toolUse',
      ),
      response([{ type: 'text', text: 'Done.' }], 'stop'),
    ]);

    expect(result.materialSeen).toEqual({ 'call-a': true, 'call-b': true });
    expect(result.advisorRequests).toHaveLength(2);
    const mainFollowUp = JSON.stringify(result.mainRequests[1]?.messages);
    expect(mainFollowUp).toContain('Advice one.');
    expect(mainFollowUp).toContain('Advice two.');
    // Each call's material is released after the call; the Turn's request view at Turn end.
    expect(result.storeAfterRun).toBe(1);
    expect(result.storeAfterTurnEnd).toBe(0);
  });
});
