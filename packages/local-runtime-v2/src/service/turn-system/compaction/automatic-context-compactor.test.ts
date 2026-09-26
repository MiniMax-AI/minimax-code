import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import { wrapInternalContext } from '@mavis/goal';
import type { PromptReadSnapshot } from '@mavis/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { readCompactionCompatibility } from './compat.js';
import {
  AutomaticContextCompactor,
  createAutomaticContextRequestFilterHook,
} from './automatic-context-compactor.js';
import { ToolResultArchiver } from './algorithm/tool-result-archiver.js';
import {
  buildCheckpointControl,
  CHECKPOINT_SYSTEM_PROMPT,
  checkpointMaxOutputTokens,
} from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
import { ContextUsageAnchorState } from './execution/usage-anchor.js';

const TOOL_RESULT_REMOVED_TEXT = '[Tool result removed by context compaction.]';
const BACKGROUND_TASK_FINISHED_NOTICE = `<background-task-finished task_id="task-1">
The following local background tasks reached a terminal state. Use task_output with each task_id to read the result before reporting to the user.
</background-task-finished>`;

type AutomaticCompactorConstructorArgs = ConstructorParameters<typeof AutomaticContextCompactor>;

function automaticCompactor(
  usageAnchor: AutomaticCompactorConstructorArgs[0] = undefined,
  checkpointState: AutomaticCompactorConstructorArgs[1] = undefined,
  logger: AutomaticCompactorConstructorArgs[2] = undefined,
  dependencies: AutomaticCompactorConstructorArgs[3] = {},
) {
  return new AutomaticContextCompactor(usageAnchor, checkpointState, logger, dependencies);
}

describe('AutomaticContextCompactor usage anchor', () => {
  it('uses only an exact request binding for the process-local usage anchor', async () => {
    const model: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages' as const,
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const systemPrompt = 'stable system';
    const tools = [{ name: 'read', description: 'Read', parameters: { type: 'object' } }];
    const anchored: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      responseId: 'response-1',
      usage: {
        input: 89_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 90_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    };
    const exactState = new ContextUsageAnchorState();
    exactState.bind({
      scope: 'session-1',
      provider: model.provider,
      api: model.api,
      model: model.id,
      systemPrompt,
      tools,
    });
    exactState.recordBound('session-1', [anchored]);

    await expect(
      automaticCompactor(exactState).compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages: [anchored],
        model,
        thinkingLevel: 'off',
        systemPrompt,
        tools,
      }),
    ).rejects.toThrow(/streamFn/i);

    const staleState = new ContextUsageAnchorState();
    staleState.bind({
      scope: 'session-1',
      provider: model.provider,
      api: model.api,
      model: model.id,
      systemPrompt,
      tools,
    });
    staleState.recordBound('session-1', [anchored]);
    await expect(
      automaticCompactor(staleState).compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages: [anchored],
        model,
        thinkingLevel: 'off',
        systemPrompt: 'changed system',
        tools,
      }),
    ).resolves.toEqual({ status: 'unchanged', reason: 'nothing-to-compact' });
  });
});

describe('AutomaticContextCompactor', () => {
  it('exposes the caller-shaped compactBeforeLlm method', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'context' }], timestamp: 1 },
    ];
    const captureSubagents = vi.fn(async () => undefined);
    const compactor = automaticCompactor(undefined, { captureSubagents });

    await expect(
      compactor.compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages,
        thinkingLevel: 'off',
        model: {
          id: 'model-1',
          name: 'Model 1',
          api: 'anthropic-messages',
          provider: 'test',
          baseUrl: 'https://example.invalid',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4_096,
        },
      }),
    ).resolves.toBeDefined();
    expect(captureSubagents).not.toHaveBeenCalled();
  });

  it('uses the full provider footprint with a strict greater-than trigger boundary', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'old request' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'old response' }],
        timestamp: 2,
        provider: 'test',
        api: 'anthropic-messages',
        model: 'model-1',
        stopReason: 'stop',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      { role: 'user', content: [{ type: 'text', text: 'latest request' }], timestamp: 3 },
    ];
    const systemPrompt = 'Follow the system instructions.';
    const tools = [
      {
        name: 'search',
        description: 'Search',
        parameters: { type: 'object', properties: {} },
      },
    ];
    const model: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages' as const,
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 4_096,
    };
    const inputTokens = createLocalContextFootprintMeasurer({
      model,
      systemPrompt,
      tools,
    }).measure(messages).inputTokens;
    const compactor = automaticCompactor();
    const input = {
      sessionId: 'session-1',
      phase: 'initial' as const,
      messages,
      model,
      thinkingLevel: 'off' as const,
      systemPrompt,
      tools,
    };
    const belowTriggerInput = {
      ...input,
      model: { ...model, contextWindow: inputTokens + 16_384 },
    };
    const aboveTriggerInput = {
      ...input,
      model: { ...model, contextWindow: inputTokens + 16_383 },
    };

    expect(compactor.probeBeforeLlm(belowTriggerInput).shouldStart).toBe(false);
    await expect(compactor.compactBeforeLlm(belowTriggerInput)).resolves.toEqual({
      status: 'unchanged',
      reason: 'nothing-to-compact',
    });
    const aboveTriggerProbe = compactor.probeBeforeLlm(aboveTriggerInput);
    expect(aboveTriggerProbe.shouldStart).toBe(true);
    await expect(compactor.compactBeforeLlm(aboveTriggerInput)).rejects.toThrow(/streamFn/i);
  });
});

describe('AutomaticContextCompactor request filtering', () => {
  it('preserves append-only Goal context and identical user Background XML', async () => {
    const oldWrapper: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: wrapInternalContext('goal', 'past') }],
      timestamp: 1,
    };
    const userMessage: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: `real request\n${BACKGROUND_TASK_FINISHED_NOTICE}` }],
      timestamp: 2,
    };
    const latestWrapper: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: wrapInternalContext('goal', 'current') }],
      timestamp: 3,
    };
    const messages = [oldWrapper, userMessage, latestWrapper];
    const snapshot = structuredClone(messages);

    const result = await createAutomaticContextRequestFilterHook()({ messages } as never);

    expect(result).toEqual({ type: 'continue' });
    expect(messages).toEqual(snapshot);
  });

  it('keeps provider requests prefix-stable across pure Goal continuation messages', async () => {
    const kickoff: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: wrapInternalContext('goal', 'kickoff') }],
      timestamp: 1,
    };
    const firstReply: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'first reply' }],
      api: 'anthropic-messages',
      provider: 'test',
      model: 'model-1',
      stopReason: 'stop',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    };
    const continuation: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: wrapInternalContext('goal', 'continue') }],
      timestamp: 3,
    };
    const previousRequest = [kickoff, firstReply, continuation];
    const nextRequest = [
      ...previousRequest,
      { ...firstReply, content: [{ type: 'text' as const, text: 'second reply' }], timestamp: 4 },
      {
        ...continuation,
        content: [{ type: 'text' as const, text: wrapInternalContext('goal', 'continue again') }],
        timestamp: 5,
      },
    ];

    expect(
      createAutomaticContextRequestFilterHook()({ messages: previousRequest } as never),
    ).toEqual({ type: 'continue' });
    expect(createAutomaticContextRequestFilterHook()({ messages: nextRequest } as never)).toEqual({
      type: 'continue',
    });
    expect(nextRequest.slice(0, previousRequest.length)).toEqual(previousRequest);
  });

  it('starts byte-pressure policy from raw H0 before transient filtering', async () => {
    const oldWrapper: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: wrapInternalContext('goal', 'past '.repeat(1_000)) }],
      timestamp: 1,
    };
    const userMessage: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'real request' }],
      timestamp: 2,
    };
    const latestWrapper: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: wrapInternalContext('goal', 'current') }],
      timestamp: 3,
    };
    const messages = [oldWrapper, userMessage, latestWrapper];
    const model: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages',
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const measurer = createLocalContextFootprintMeasurer({ model });
    const maxSerializedInputBytes = measurer.measure([userMessage, latestWrapper]).serializedBytes;
    expect(measurer.measure(messages).serializedBytes).toBeGreaterThan(maxSerializedInputBytes);

    await expect(
      automaticCompactor().compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages,
        model,
        thinkingLevel: 'off',
        maxSerializedInputBytes,
      }),
    ).rejects.toThrow(/streamFn/i);
  });
});

describe('AutomaticContextCompactor ToolResult reduction policy', () => {
  it('commits recoverable tool_archive below the context trigger without Provider transport', async () => {
    const messages = Array.from({ length: 10 }, (_, index): AgentMessage[] => {
      const id = `archive-${index}`;
      return [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id, name: 'read', arguments: { path: `/${id}` } }],
          provider: 'test',
          api: 'anthropic-messages',
          model: 'model-1',
          stopReason: 'toolUse',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: index * 2 + 1,
        } as AgentMessage,
        {
          role: 'toolResult',
          toolCallId: id,
          toolName: 'read',
          content: [{ type: 'text', text: 'x'.repeat(64 * 1_024) }],
          isError: false,
          timestamp: index * 2 + 2,
        },
      ];
    }).flat();
    const snapshot = structuredClone(messages);
    const writeArtifact = vi.fn(async (input: { readonly toolCallId: string }) => ({
      reference: `/session/reports/tool-outputs/${input.toolCallId}.txt`,
    }));
    const archiver = new ToolResultArchiver({ writeArtifact });
    const plan = vi.spyOn(archiver, 'plan');
    const model: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages',
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 4_096,
    };

    const compactor = automaticCompactor(undefined, undefined, undefined, {
      toolResultArchiver: archiver,
    });
    const input = {
      sessionId: 'session-1',
      phase: 'initial' as const,
      messages,
      model,
      thinkingLevel: 'off' as const,
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    };

    const probe = compactor.probeBeforeLlm(input);
    expect(probe.shouldStart).toBe(true);
    const result = await compactor.compactBeforeLlm({
      ...input,
      messages: structuredClone(messages),
    });

    expect(result).toMatchObject({
      status: 'completed',
      method: 'tool_archive',
      strategyVersion: 'local-context-compaction-v3',
    });
    if (result.status !== 'completed') throw new Error('Expected durable ToolResult archive.');
    expect(
      result.replacementMessages.filter((message) =>
        JSON.stringify(message).includes('Earlier tool output externalized'),
      ),
    ).toHaveLength(5);
    expect(writeArtifact).toHaveBeenCalledTimes(5);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(messages).toEqual(snapshot);
  });
});

describe('AutomaticContextCompactor destructive ToolResult policy', () => {
  it('commits destructive tool_trim below the context trigger when read is unavailable', async () => {
    const messages = Array.from({ length: 10 }, (_, index): AgentMessage[] => {
      const id = `trim-${index}`;
      return [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id, name: 'bash', arguments: { cmd: `task-${index}` } }],
          provider: 'test',
          api: 'anthropic-messages',
          model: 'model-1',
          stopReason: 'toolUse',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: index * 2 + 1,
        } as AgentMessage,
        {
          role: 'toolResult',
          toolCallId: id,
          toolName: 'bash',
          content: [{ type: 'text', text: 'x'.repeat(64 * 1_024) }],
          isError: false,
          timestamp: index * 2 + 2,
        },
      ];
    }).flat();
    const snapshot = structuredClone(messages);
    const writeArtifact = vi.fn(async () => ({ reference: '/must-not-be-written.txt' }));
    const archiver = new ToolResultArchiver({ writeArtifact });
    const plan = vi.spyOn(archiver, 'plan');
    const model: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages',
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 4_096,
    };

    const compactor = automaticCompactor(undefined, undefined, undefined, {
      toolResultArchiver: archiver,
    });
    const input = {
      sessionId: 'session-no-read',
      phase: 'initial' as const,
      messages,
      model,
      thinkingLevel: 'off' as const,
      tools: [{ name: 'bash', description: 'Bash', parameters: { type: 'object' } }],
    };
    const probe = compactor.probeBeforeLlm(input);

    expect(probe.shouldStart).toBe(true);
    const result = await compactor.compactBeforeLlm({
      ...input,
      messages: structuredClone(messages),
    });

    expect(result).toMatchObject({
      status: 'completed',
      method: 'tool_trim',
      strategyVersion: 'local-context-compaction-v3',
    });
    if (result.status !== 'completed') throw new Error('Expected destructive ToolResult trim.');
    const trimmedText = JSON.stringify(result.replacementMessages);
    expect(trimmedText.match(/original content unavailable/g)).toHaveLength(5);
    expect(trimmedText).not.toMatch(/restore|tool-outputs\//i);
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(result.replacementMessages.slice(-10)).toEqual(messages.slice(-10));
    expect(messages).toEqual(snapshot);
  });
});

describe('AutomaticContextCompactor ToolResult archive failure', () => {
  it('stays unchanged when an archive-only trigger cannot persist any artifact', async () => {
    const messages = Array.from({ length: 10 }, (_, index): AgentMessage[] => {
      const id = `archive-failure-${index}`;
      return [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id, name: 'read', arguments: { path: `/${id}` } }],
          provider: 'test',
          api: 'anthropic-messages',
          model: 'model-1',
          stopReason: 'toolUse',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: index * 2 + 1,
        } as AgentMessage,
        {
          role: 'toolResult',
          toolCallId: id,
          toolName: 'read',
          content: [{ type: 'text', text: 'x'.repeat(64 * 1_024) }],
          isError: false,
          timestamp: index * 2 + 2,
        },
      ];
    }).flat();
    const writeArtifact = vi.fn(async () => {
      throw new Error('disk unavailable');
    });
    const archiver = new ToolResultArchiver({ writeArtifact });
    const model: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages',
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 4_096,
    };

    await expect(
      automaticCompactor(undefined, undefined, undefined, {
        toolResultArchiver: archiver,
      }).compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages,
        model,
        thinkingLevel: 'off',
        tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
      }),
    ).resolves.toEqual({ status: 'unchanged', reason: 'nothing-to-compact' });
    expect(writeArtifact).toHaveBeenCalledTimes(5);
  });
});

describe('AutomaticContextCompactor legacy ToolResult reduction compatibility', () => {
  it('admits tool_trim above the raw trigger without requiring streamFn', async () => {
    const toolMessages = Array.from({ length: 10 }, (_, index): AgentMessage[] => {
      const id = `read-${index}`;
      return [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id, name: 'read', arguments: { path: `/${id}` } }],
          timestamp: index * 2 + 1,
          provider: 'test',
          api: 'anthropic-messages',
          model: 'model-1',
          stopReason: 'toolUse',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        } as AgentMessage,
        {
          role: 'toolResult',
          toolCallId: id,
          toolName: 'read',
          content: [{ type: 'text', text: index < 7 ? 'x'.repeat(20_000) : `${id} output` }],
          isError: false,
          timestamp: index * 2 + 2,
        },
      ];
    }).flat();
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `keep this request\n${BACKGROUND_TASK_FINISHED_NOTICE}`,
          },
        ],
        timestamp: -1,
      },
      ...toolMessages,
      {
        role: 'user',
        content: [{ type: 'text', text: wrapInternalContext('goal', 'current') }],
        timestamp: toolMessages.length + 1,
      },
    ];
    const snapshot = structuredClone(messages);
    const model: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages' as const,
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 4_096,
    };
    const rawTokens = createLocalContextFootprintMeasurer({ model }).measure(messages).inputTokens;
    const triggerAt = rawTokens - 1;
    const onStarted = vi.fn();
    const usageAnchor = new ContextUsageAnchorState();
    const invalidate = vi.spyOn(usageAnchor, 'invalidate');

    const result = await automaticCompactor(usageAnchor).compactBeforeLlm(
      {
        sessionId: 'session-1',
        phase: 'initial',
        messages,
        thinkingLevel: 'off',
        model: { ...model, contextWindow: rawTokens + 16_383 },
      },
      { onStarted },
    );

    expect(result).toMatchObject({
      status: 'completed',
      method: 'tool_trim',
      messagesBefore: messages.length,
      messagesAfter: messages.length,
    });
    if (result.status !== 'completed') throw new Error('Expected completed tool trim.');
    if (result.method !== 'tool_trim') throw new Error('Expected tool trim lineage.');
    expect(result.replacementSourceIndexes).toEqual(
      Array.from({ length: messages.length }, (_entry, index) => index),
    );
    expect(result.replacementMessages[0]).toEqual(messages[0]);
    const requestDecision = await createAutomaticContextRequestFilterHook()({
      messages: [...result.replacementMessages],
    } as never);
    expect(requestDecision).toEqual({ type: 'continue' });
    expect(
      result.replacementMessages.filter((message) =>
        message.role === 'toolResult' && message.content[0]?.type === 'text'
          ? message.content[0].text === TOOL_RESULT_REMOVED_TEXT
          : false,
      ).length,
    ).toBe(7);
    expect(result).not.toHaveProperty('summary');
    expect(Number.isSafeInteger(result.tokensBefore)).toBe(true);
    expect(Number.isSafeInteger(result.tokensAfter)).toBe(true);
    expect(Number.isSafeInteger(result.serializedBytesBefore)).toBe(true);
    expect(Number.isSafeInteger(result.serializedBytesAfter)).toBe(true);
    expect(result.tokensAfter).toBeLessThanOrEqual(triggerAt);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith('session-1');
    expect(messages).toEqual(snapshot);

    await expect(
      automaticCompactor().compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages,
        thinkingLevel: 'off',
        model: { ...model, contextWindow: rawTokens + 16_383 },
        maxSerializedInputBytes: 1,
      }),
    ).rejects.toThrow(/streamFn/i);
  });
});

describe('AutomaticContextCompactor checkpoint transport', () => {
  it('creates a native checkpoint through the selected Provider transport', async () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: wrapInternalContext('goal', 'past '.repeat(80_000)) }],
        timestamp: 1,
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Preserve this request. '.repeat(300) }],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [{ type: 'text', text: wrapInternalContext('goal', 'current') }],
        timestamp: 3,
      },
    ];
    const systemPrompt = 'System context.';
    const tools = [
      {
        name: 'search',
        description: 'Search',
        parameters: { type: 'object', properties: {} },
      },
    ];
    const headers = { 'x-provider-route': 'route-a' };
    const payloadTransform = vi.fn((payload: unknown) => payload);
    const controller = new AbortController();
    const baseModel: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages' as const,
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      // Reserving a quarter-window output keeps the H0 fixture above the
      // automatic trigger while the checkpoint request still fits the hard limit.
      maxTokens: 32_000,
    };
    const rawTokens = createLocalContextFootprintMeasurer({
      model: baseModel,
      systemPrompt,
      tools,
    }).measure(messages).inputTokens;
    const model = { ...baseModel, contextWindow: rawTokens + 24_000 };
    const summary = `## Goal
Preserve the request.

## Constraints & Preferences
Keep exact context.

## Completed Work
(none)

## Current State
Checkpoint requested.

## Blockers
(none)

## Key Decisions
Use native checkpoint.

## Pending User Asks
Continue.

## Critical Context & Relevant Files
(none)`;
    const final: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: summary }],
      api: 'anthropic-messages',
      provider: 'test',
      model: model.id,
      usage: {
        input: 0,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 2,
    };
    const streamFn: StreamFn = vi.fn(() => completedStream(final));
    const onStarted = vi.fn();
    const captureSubagents = vi.fn(async () => ({
      capturedAtMs: 4,
      total: 1,
      counts: {
        queued: 0,
        running: 1,
        stopping: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        lost: 0,
      },
      omitted: 0,
      textFieldsAreUntrusted: true as const,
      detailsHint:
        'Call task_query for the live task list, then task_output(task_id) for progress or results.' as const,
      items: [
        {
          taskId: 'bg-live',
          status: 'running' as const,
          updatedAtMs: 3,
          delivered: false,
          description: 'live work',
        },
      ],
    }));
    const onCheckpointAttemptSettled = vi.fn();
    const onCheckpointGenerated = vi.fn();
    const writeArtifact = vi.fn(async () => ({ reference: '/must-not-be-written.txt' }));
    const archiver = new ToolResultArchiver({ writeArtifact });
    const promptSnapshot = {} as PromptReadSnapshot;
    const managedCheckpointPrompt = `${CHECKPOINT_SYSTEM_PROMPT}\nManaged checkpoint extension.`;
    const promptSnapshots = {
      capture: vi.fn(async () => promptSnapshot),
      captureBuiltin: vi.fn(async () => promptSnapshot),
      read: vi.fn(async () => ({ kind: 'found' as const, content: managedCheckpointPrompt })),
    };
    const snapshot = structuredClone({ messages, systemPrompt, tools, headers });

    const result = await automaticCompactor(undefined, { captureSubagents }, undefined, {
      toolResultArchiver: archiver,
      promptSnapshots,
    }).compactBeforeLlm(
      {
        sessionId: 'session-1',
        phase: 'initial',
        messages,
        model,
        streamFn,
        apiKey: 'provider-key',
        headers,
        payloadTransform,
        maxSerializedInputBytes: Number.MAX_SAFE_INTEGER,
        systemPrompt,
        tools,
        thinkingLevel: 'medium',
        signal: controller.signal,
      },
      { onStarted, onCheckpointAttemptSettled, onCheckpointGenerated },
    );

    expect(result).toMatchObject({ status: 'completed', method: 'llm_checkpoint', summary });
    if (result.status !== 'completed') throw new Error('Expected completed checkpoint.');
    expect(result.replacementMessages[0]?.role).toBe('compactionSummary');
    expect(
      readCompactionCompatibility(result.replacementMessages[0] as AgentMessage | undefined)
        ?.subagents,
    ).toMatchObject({
      capturedAtMs: 4,
      items: [{ taskId: 'bg-live' }],
    });
    expect(captureSubagents).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(onStarted).toHaveBeenCalledOnce();
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(onCheckpointAttemptSettled).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: 'h0', attemptNumber: 1, outcome: 'generated' }),
    );
    expect(onCheckpointGenerated).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledOnce();
    const [calledModel, context, options] = vi.mocked(streamFn).mock.calls[0] ?? [];
    expect(calledModel).toBe(model);
    expect(context).toEqual({
      systemPrompt: managedCheckpointPrompt,
      messages: [
        messages[0],
        messages[1],
        messages[2],
        {
          role: 'user',
          content: [{ type: 'text', text: buildCheckpointControl() }],
          timestamp: 3,
        },
      ],
    });
    expect(JSON.stringify(context)).toContain('past');
    expect(promptSnapshots.capture).toHaveBeenCalledOnce();
    expect(promptSnapshots.read).toHaveBeenCalledOnce();
    expect(options).toEqual({
      apiKey: 'provider-key',
      headers,
      reasoning: 'medium',
      maxTokens: checkpointMaxOutputTokens(16_384, model.maxTokens, model.contextWindow),
      onPayload: payloadTransform,
      signal: controller.signal,
    });
    expect({ messages, systemPrompt, tools, headers }).toEqual(snapshot);

    await expectBuiltinCheckpointPrompt(
      { sessionId: 'session-builtin', phase: 'initial', messages, model, systemPrompt, tools },
      final,
    );
  });
});

describe('AutomaticContextCompactor request boundaries', () => {
  it('does not start Spark compaction for a low-pressure turn', async () => {
    await expect(
      automaticCompactor().compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'small context' }], timestamp: 1 },
        ],
        thinkingLevel: 'off',
        model: {
          id: 'gpt-5.3-codex-spark',
          name: 'GPT-5.3 Codex Spark',
          api: 'openai-codex-responses',
          provider: 'openai-codex',
          baseUrl: 'https://example.invalid',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 128_000,
        },
      }),
    ).resolves.toEqual({ status: 'unchanged', reason: 'nothing-to-compact' });
  });

  it('starts only when the raw serialized footprint strictly exceeds the byte cap', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'byte boundary' }], timestamp: 1 },
    ];
    const model: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages',
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const serializedBytes = createLocalContextFootprintMeasurer({ model }).measure(
      messages,
    ).serializedBytes;
    const input = {
      sessionId: 'session-1',
      phase: 'initial' as const,
      messages,
      model,
      thinkingLevel: 'off' as const,
    };

    await expect(
      automaticCompactor().compactBeforeLlm({
        ...input,
        maxSerializedInputBytes: serializedBytes,
      }),
    ).resolves.toEqual({ status: 'unchanged', reason: 'nothing-to-compact' });
    await expect(
      automaticCompactor().compactBeforeLlm({
        ...input,
        maxSerializedInputBytes: serializedBytes - 1,
      }),
    ).rejects.toThrow(/streamFn/i);
  });

  it('uses the requested Messages API maxTokens at the trigger boundary', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'small context' }], timestamp: 1 },
    ];
    const baseModel: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages' as const,
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 32_768,
    };
    const rawTokens = createLocalContextFootprintMeasurer({ model: baseModel }).measure(
      messages,
    ).inputTokens;

    await expect(
      automaticCompactor().compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages,
        thinkingLevel: 'off',
        model: { ...baseModel, contextWindow: rawTokens + 34_816 },
        maxTokens: 32_768,
      }),
    ).resolves.toEqual({ status: 'unchanged', reason: 'nothing-to-compact' });
  });

  it('uses the same conservative input limit for checkpoint candidate fit', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(20_000) }], timestamp: 1 },
    ];
    const streamFn = vi.fn<StreamFn>();

    await expect(
      automaticCompactor().compactBeforeLlm({
        sessionId: 'session-1',
        phase: 'initial',
        messages,
        thinkingLevel: 'off',
        model: {
          id: 'model-1',
          name: 'Model 1',
          api: 'anthropic-messages',
          provider: 'test',
          baseUrl: 'https://example.invalid',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 20_000,
          maxTokens: 4_096,
        },
        streamFn,
      }),
    ).rejects.toMatchObject({ code: 'COMPACTION_INPUT_TOO_LARGE' });
    expect(streamFn).not.toHaveBeenCalled();
  });

  it('starts Spark compaction before one large tool round can strand checkpoint generation', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(100_000) }], timestamp: 1 },
    ];
    const model: Model<'openai-codex-responses'> = {
      id: 'gpt-5.3-codex-spark',
      name: 'GPT-5.3 Codex Spark',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      baseUrl: 'https://example.invalid',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 128_000,
    };
    const input = {
      sessionId: 'session-1',
      phase: 'initial' as const,
      messages,
      thinkingLevel: 'off' as const,
      model,
    };
    const footprint = createLocalContextFootprintMeasurer({ model }).measure(messages);

    expect(footprint.inputTokens).toBeGreaterThan(91_200);
    expect(footprint.inputTokens).toBeLessThan(109_568);
    expect(automaticCompactor().probeBeforeLlm(input).shouldStart).toBe(true);

    await expect(automaticCompactor().compactBeforeLlm(input)).rejects.toThrow(/streamFn/i);
  });

  it('rejects a pre-aborted request before hooks or Provider transport', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'short context' }], timestamp: 1 },
    ];
    const snapshot = structuredClone(messages);
    const reason = new Error('cancelled before compaction');
    const controller = new AbortController();
    controller.abort(reason);
    const streamFn = vi.fn<StreamFn>();
    const onStarted = vi.fn();

    await expect(
      automaticCompactor().compactBeforeLlm(
        {
          sessionId: 'session-1',
          phase: 'initial',
          messages,
          thinkingLevel: 'off',
          model: {
            id: 'model-1',
            name: 'Model 1',
            api: 'anthropic-messages',
            provider: 'test',
            baseUrl: 'https://example.invalid',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 4_096,
          },
          streamFn,
          signal: controller.signal,
        },
        { onStarted },
      ),
    ).rejects.toBe(reason);
    expect(streamFn).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(messages).toEqual(snapshot);
  });
});

describe('AutomaticContextCompactor checkpoint output budget', () => {
  it('scales the checkpoint output cap with the context window', async () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'long session history '.repeat(60_000) }],
        timestamp: 1,
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }], timestamp: 2 },
    ];
    const baseModel: Model<'anthropic-messages'> = {
      id: 'model-1',
      name: 'Model 1',
      api: 'anthropic-messages',
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 128_000,
    };
    const rawTokens = createLocalContextFootprintMeasurer({ model: baseModel }).measure(
      messages,
    ).inputTokens;
    const model = { ...baseModel, contextWindow: rawTokens + 24_000 };
    const windowShare = Math.floor(model.contextWindow / 8);
    expect(windowShare).toBeGreaterThan(13_107);
    const streamFn: StreamFn = vi.fn(() =>
      completedStream({
        role: 'assistant',
        content: [{ type: 'text', text: '## Goal\nContinue.' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 3,
      }),
    );

    await expect(
      automaticCompactor().compactBeforeLlm({
        sessionId: 'session-window-share',
        phase: 'initial',
        messages,
        model,
        streamFn,
        thinkingLevel: 'off',
      }),
    ).resolves.toMatchObject({ status: 'completed', method: 'llm_checkpoint' });
    expect(vi.mocked(streamFn).mock.calls[0]?.[2]?.maxTokens).toBe(windowShare);
  });
});

function completedStream(final: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message: final });
  return stream;
}

async function expectBuiltinCheckpointPrompt(
  input: Omit<
    Parameters<AutomaticContextCompactor['compactBeforeLlm']>[0],
    'streamFn' | 'thinkingLevel'
  >,
  final: AssistantMessage,
): Promise<void> {
  const streamFn: StreamFn = vi.fn(() => completedStream(final));
  await expect(
    automaticCompactor().compactBeforeLlm({
      ...input,
      streamFn,
      thinkingLevel: 'off',
    }),
  ).resolves.toMatchObject({ status: 'completed', method: 'llm_checkpoint' });
  expect(vi.mocked(streamFn).mock.calls[0]?.[1]?.systemPrompt).toBe(CHECKPOINT_SYSTEM_PROMPT);
}
