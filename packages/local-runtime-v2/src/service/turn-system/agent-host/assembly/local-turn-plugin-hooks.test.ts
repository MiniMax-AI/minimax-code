import { describe, expect, it, vi } from 'vitest';
import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import {
  createLocalPluginHookEventReporter,
  emitLocalPluginHookWarnings,
} from './local-turn-plugin-hooks.js';

describe('Plugin Hook display messages', () => {
  it('deduplicates diagnostics but retains system messages across tool calls', async () => {
    const appendEvents = vi.fn(
      async (_events: Parameters<PiEventWriter['appendEvents']>[0]) => undefined,
    );
    const reporter = createLocalPluginHookEventReporter({
      writer: { appendEvents, pushRuntime: vi.fn() },
      sessionId: 'session-dedupe',
      turnId: 'turn-dedupe',
    });
    const result = {
      decision: {
        decision: 'allow' as const,
        systemMessage: 'initial system message',
        terminalSequence: '\u0007',
      },
      diagnostics: [
        {
          code: 'HOOK_INVALID_INPUT' as const,
          pluginName: 'compatible-tools',
          event: 'PostToolUse' as const,
          sourcePath: '/plugin/hook.mjs',
          declarationOrder: 0,
        },
      ],
    };
    const repeatedResult = {
      ...result,
      decision: {
        ...result.decision,
        systemMessage: 'a later system message from the same event category',
        terminalSequence: '\u001b[0m',
      },
    };

    await emitLocalPluginHookWarnings({
      reporter,
      sessionId: 'session-dedupe',
      turnId: 'turn-dedupe',
      event: 'PostToolUse',
      result,
    });
    await emitLocalPluginHookWarnings({
      reporter,
      sessionId: 'session-dedupe',
      turnId: 'turn-dedupe',
      event: 'PostToolUse',
      result: repeatedResult,
    });

    await emitLocalPluginHookWarnings({
      reporter,
      sessionId: 'session-dedupe',
      turnId: 'turn-dedupe',
      event: 'PostToolUse',
      result: repeatedResult,
    });

    expect(appendEvents).toHaveBeenCalledTimes(3);
    const emitted = appendEvents.mock.calls.flatMap(([events]) =>
      events.map((event) => {
        const envelope = JSON.parse(event.payload.stream_resp as string);
        return {
          id: envelope.agent_message.msg_id,
          ...JSON.parse(envelope.agent_message.msg_content),
        };
      }),
    );
    const messages = emitted.filter((event) => event.category === 'system-message');
    expect(messages.map((event) => event.message)).toEqual([
      'initial system message',
      'a later system message from the same event category',
      'a later system message from the same event category',
    ]);
    expect(new Set(messages.map((event) => event.id)).size).toBe(3);
    expect(emitted.filter((event) => event.category === 'diagnostic')).toHaveLength(1);
    expect(emitted.filter((event) => event.category === 'terminal-control')).toHaveLength(1);
    const serialized = JSON.stringify(appendEvents.mock.calls[0]?.[0]);
    expect(serialized).toContain('was skipped');
    expect(serialized).toContain('tool execution and result were not changed');
    expect(serialized).toContain('HOOK_INVALID_INPUT');
  });

  it('preserves identical text in different categories and keeps delivery failure best-effort', async () => {
    const appendEvents = vi.fn<PiEventWriter['appendEvents']>().mockResolvedValue(undefined);
    const reporter = createLocalPluginHookEventReporter({
      writer: { appendEvents, pushRuntime: vi.fn() },
      sessionId: 'category-session',
      turnId: 'category-turn',
    });
    const input = {
      reporter,
      sessionId: 'category-session',
      turnId: 'category-turn',
      event: 'Stop' as const,
      message: 'same text',
      decision: { decision: 'allow' as const, systemMessage: 'same text' },
    };
    await emitLocalPluginHookWarnings(input);
    expect(appendEvents.mock.calls[0]?.[0]).toHaveLength(2);
    appendEvents.mockRejectedValueOnce(new Error('writer unavailable'));
    await expect(emitLocalPluginHookWarnings(input)).resolves.toBeUndefined();
    expect(input.decision).toEqual({
      decision: 'allow',
      systemMessage: 'same text',
    });
  });
});
