/**
 * mavis "session messages" returns message text in full and one summary per
 * tool call; tool results, thinking and usage statistics are opt-in or left
 * out, so a Session holding multi-megabyte run_code child results reads back
 * in a bounded response (desktop/local-mavis-session-messages.ts).
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalMavisTool } from '../../src/desktop/local-mavis.js';
import type {
  LocalMavisAgentAdapter,
  LocalMavisSessionAdapter,
  LocalRuntimeToolContext,
} from '../../src/desktop/types.js';

const DIRECT: LocalRuntimeToolContext = {
  sessionId: 'mvs_caller',
  turnId: 'turn-current',
  toolCallId: 'call-direct',
  agentName: 'mavis',
};
const CHILD: LocalRuntimeToolContext = { ...DIRECT, parentToolCallId: 'run-code-1' };

const LONG_TEXT = '正文🙂'.repeat(20_000);
const CHILD_RESULT = JSON.stringify({ content: [{ type: 'text', text: 'r'.repeat(50_000) }] });
const LONG_ARGS = JSON.stringify({ code: 'x'.repeat(1_000) });

function storedMessages(): unknown[] {
  return [
    {
      msg_id: 'msg-user',
      role: 'user',
      msg_type: 1,
      timestamp: 1,
      turn_id: 'turn-1',
      msg_content: LONG_TEXT,
      attachments: [
        {
          type: 'image',
          file_path: '/tmp/a.png',
          file_name: 'a.png',
          mime_type: 'image/png',
          data_url: `data:image/png;base64,${'A'.repeat(100_000)}`,
        },
      ],
    },
    {
      msg_id: 'msg-assistant',
      role: 'assistant',
      msg_type: 2,
      turn_id: 'turn-1',
      msg_content: 'Done.',
      thinking_content: 't'.repeat(5_000),
      thinking_duration_ms: 12,
      finish_reason: 'stop',
      usage: { total_tokens: 10, context_window: 200_000 },
      context_usage: { contextWindowTokens: 1, usedTokens: 1, totalCountSource: 'LOCAL_ESTIMATE', components: [] },
      context_usage_telemetry: { trigger: 'terminal', turnId: 'turn-1', model: 'm', localTokens: 1 },
      tool_calls: [
        {
          tool_name: 'run_code',
          tool_call_id: 'run-code-1',
          tool_call_status: 2,
          tool_call_args: LONG_ARGS,
          tool_call_result_data: '{"content":[{"type":"text","text":"ok"}]}',
          tool_call_duration_ms: 5,
        },
        {
          tool_name: 'read',
          tool_call_id: 'child-read',
          parent_tool_call_id: 'run-code-1',
          tool_call_status: 2,
          tool_call_args: '{"path":"big.txt"}',
          tool_call_result_data: CHILD_RESULT,
        },
        {
          tool_name: 'bash',
          tool_call_id: 'child-bash',
          parent_tool_call_id: 'run-code-1',
          tool_call_status: 3,
          tool_call_args: '{"command":"false"}',
          tool_call_result_data: '{"error":"exit 1"}',
        },
      ],
    },
  ];
}

describe('mavis session messages projection', () => {
  it('keeps message text whole and summarizes every tool call by default', async () => {
    const response = await read({ session_id: 'mvs_target' });

    expect(response).toEqual({
      hasMore: false,
      messages: [
        {
          msg_id: 'msg-user',
          role: 'user',
          msg_type: 1,
          timestamp: 1,
          turn_id: 'turn-1',
          msg_content: LONG_TEXT,
          attachments: [
            { type: 'image', file_path: '/tmp/a.png', file_name: 'a.png', mime_type: 'image/png' },
          ],
        },
        {
          msg_id: 'msg-assistant',
          role: 'assistant',
          msg_type: 2,
          turn_id: 'turn-1',
          msg_content: 'Done.',
          finish_reason: 'stop',
          tool_calls: [
            {
              tool_name: 'run_code',
              tool_call_id: 'run-code-1',
              status: 'completed',
              args_preview: LONG_ARGS.slice(0, 200),
              args_chars: LONG_ARGS.length,
              result_chars: 41,
            },
            {
              tool_name: 'read',
              tool_call_id: 'child-read',
              parent_tool_call_id: 'run-code-1',
              status: 'completed',
              args_preview: '{"path":"big.txt"}',
              args_chars: 18,
              result_chars: CHILD_RESULT.length,
            },
            {
              tool_name: 'bash',
              tool_call_id: 'child-bash',
              parent_tool_call_id: 'run-code-1',
              status: 'failed',
              args_preview: '{"command":"false"}',
              args_chars: 19,
              result_chars: 18,
            },
          ],
        },
      ],
    });
  });

  it('keeps structured attachment metadata and drops every inline data URL', async () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(100_000)}`;
    const listMessages = async () => ({
      messages: [
        {
          msg_id: 'msg-attachments',
          role: 'user',
          msg_content: 'See the files.',
          attachments: [
            {
              meta: { attachmentType: 'image', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 1234 },
              local: {
                assetId: 'asset-1',
                filePath: '/tmp/assets/shot.png',
                desktopPath: '/Users/u/Desktop/shot.png',
                dataUrl,
              },
            },
            {
              meta: { attachmentType: 'file', fileName: 'a.pdf', mimeType: 'application/pdf' },
              cloud: {
                uploadId: 'upload-1',
                driveNodeId: 'node-1',
                url: 'https://cdn.example/a.pdf',
                objectKey: 'objects/a.pdf',
                dataUrl,
              },
            },
            { type: 'image', fileName: 'copy.png', filePath: '/tmp/copy.png', mimeType: 'image/png', dataUrl },
            {
              type: 'image',
              file_name: 'legacy.png',
              file_path: dataUrl,
              mime_type: 'image/png',
              data_url: dataUrl,
              local: { dataUrl },
              extra: { nested: dataUrl },
            },
          ],
        },
      ],
    });
    const response = await responseOf(await run(DIRECT, { listMessages }, { session_id: 'mvs_target' }));

    expect(messageAt(response, 0).attachments).toEqual([
      {
        meta: { attachmentType: 'image', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 1234 },
        local: {
          assetId: 'asset-1',
          filePath: '/tmp/assets/shot.png',
          desktopPath: '/Users/u/Desktop/shot.png',
        },
      },
      {
        meta: { attachmentType: 'file', fileName: 'a.pdf', mimeType: 'application/pdf' },
        cloud: {
          uploadId: 'upload-1',
          driveNodeId: 'node-1',
          url: 'https://cdn.example/a.pdf',
          objectKey: 'objects/a.pdf',
        },
      },
      { type: 'image', fileName: 'copy.png', filePath: '/tmp/copy.png', mimeType: 'image/png' },
      { type: 'image', file_name: 'legacy.png', mime_type: 'image/png' },
    ]);
    expect(JSON.stringify(response)).not.toContain('data:');
  });

  it('keeps the failure reason of preparation_error, compaction_failed and undelivered rows', async () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(10_000)}`;
    const listMessages = async () => ({
      messages: [
        {
          msg_id: 'turn-1-preparation-error',
          role: 'assistant',
          turn_id: 'turn-1',
          finish_reason: 'error',
          msg_content: '',
          preparation_error: { code: 'MODEL_UNAVAILABLE', message: 'The selected model is unavailable.' },
          query_key: 'q-1',
        },
        {
          msg_id: 'compaction-attempt-1',
          role: 'assistant',
          kind: 'compaction_failed',
          error: 'Summary request timed out',
          metadata: { internal: true },
        },
        {
          msg_id: 'msg-undelivered',
          role: 'user',
          msg_type: 1,
          kind: 'undelivered',
          msg_content: 'Also check the logs.',
          raw_json: '{"undelivered":{}}',
          undelivered: {
            v: 1,
            goal_id: 'goal-1',
            reason: 'turn_ended',
            failure: 'AbortError',
            failed_at_ms: 1_700_000_000_000,
            attempt: 0,
            input: {
              text: 'x'.repeat(50_000),
              attachments: [{ type: 'image', dataUrl }],
              display_attachments: [{ local: { dataUrl } }],
            },
          },
        },
      ],
    });
    const response = await responseOf(await run(DIRECT, { listMessages }, { session_id: 'mvs_target' }));

    expect(response.messages).toEqual([
      {
        msg_id: 'turn-1-preparation-error',
        role: 'assistant',
        turn_id: 'turn-1',
        finish_reason: 'error',
        msg_content: '',
        preparation_error: { code: 'MODEL_UNAVAILABLE', message: 'The selected model is unavailable.' },
      },
      {
        msg_id: 'compaction-attempt-1',
        role: 'assistant',
        kind: 'compaction_failed',
        error: 'Summary request timed out',
      },
      {
        msg_id: 'msg-undelivered',
        role: 'user',
        msg_type: 1,
        kind: 'undelivered',
        msg_content: 'Also check the logs.',
        undelivered: { reason: 'turn_ended', failure: 'AbortError', failed_at_ms: 1_700_000_000_000 },
      },
    ]);
    expect(JSON.stringify(response)).not.toContain('data:');
  });

  it('returns args and results cut to max_output_chars with the full length when asked', async () => {
    const response = await read({ session_id: 'mvs_target', include_tool_outputs: true });
    const [runCode, childRead, childBash] = toolCalls(response);

    expect(runCode).toEqual({
      tool_name: 'run_code',
      tool_call_id: 'run-code-1',
      status: 'completed',
      args: LONG_ARGS,
      args_chars: LONG_ARGS.length,
      result: '{"content":[{"type":"text","text":"ok"}]}',
      result_chars: 41,
    });
    expect(childRead).toEqual({
      tool_name: 'read',
      tool_call_id: 'child-read',
      parent_tool_call_id: 'run-code-1',
      status: 'completed',
      args: '{"path":"big.txt"}',
      args_chars: 18,
      result: CHILD_RESULT.slice(0, 2_000),
      result_chars: CHILD_RESULT.length,
      result_truncated: true,
    });
    expect(childBash).toMatchObject({ result: '{"error":"exit 1"}', result_chars: 18 });
    expect(childBash).not.toHaveProperty('result_truncated');
    expect(messageAt(response, 1)).not.toHaveProperty('thinking_content');
  });

  it('caps max_output_chars at 20,000 and honours smaller values', async () => {
    const wide = await read({
      session_id: 'mvs_target',
      include_tool_outputs: true,
      max_output_chars: 1_000_000,
    });
    expect(toolCalls(wide)[1]).toMatchObject({ result_chars: CHILD_RESULT.length, result_truncated: true });
    expect((toolCalls(wide)[1]?.result as string).length).toBe(20_000);

    const narrow = await read({ session_id: 'mvs_target', include_tool_outputs: true, max_output_chars: 10 });
    expect(toolCalls(narrow)[0]).toMatchObject({
      args: LONG_ARGS.slice(0, 10),
      args_chars: LONG_ARGS.length,
      args_truncated: true,
    });
  });

  it.each([0, -1, 2.5, '100'])('rejects max_output_chars %j', async (value) => {
    const listMessages = vi.fn(async () => ({ messages: storedMessages() }));
    const result = await run(DIRECT, { listMessages }, { session_id: 'mvs_target', max_output_chars: value });

    expect(JSON.parse(result.text)).toMatchObject({ ok: false, error: { kind: 'validation' } });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('returns thinking cut to max_output_chars only when asked', async () => {
    const response = await read({ session_id: 'mvs_target', include_thinking: true });
    expect(messageAt(response, 1)).toMatchObject({
      thinking_content: 't'.repeat(2_000),
      thinking_chars: 5_000,
      thinking_truncated: true,
    });
    expect(toolCalls(response)[1]).not.toHaveProperty('result');

    const whole = await read({ session_id: 'mvs_target', include_thinking: true, max_output_chars: 5_000 });
    expect(messageAt(whole, 1)).toMatchObject({ thinking_content: 't'.repeat(5_000), thinking_chars: 5_000 });
    expect(messageAt(whole, 1)).not.toHaveProperty('thinking_truncated');
  });

  it('never ends a cut inside a surrogate pair', async () => {
    const emoji = JSON.stringify('🙂'.repeat(100));
    const listMessages = async () => ({
      messages: [
        {
          msg_id: 'm',
          tool_calls: [{ tool_name: 'read', tool_call_id: 'c', tool_call_args: emoji, tool_call_result_data: emoji }],
        },
      ],
    });
    const response = await responseOf(
      await run(DIRECT, { listMessages }, { session_id: 'mvs_target', include_tool_outputs: true, max_output_chars: 4 }),
    );

    expect(toolCalls(response)[0]).toMatchObject({ args: '"🙂', result: '"🙂' });
  });

  it('projects a cloud page by the same rules and keeps its paging fields', async () => {
    const listMessages = vi.fn(async () => ({
      messages: [
        {
          msgId: 'cloud-1',
          role: 'assistant',
          msgContent: LONG_TEXT,
          msgType: 2,
          thinking_content: 'cloud thinking',
          usage: { total_tokens: 1, context_window: 1 },
          tool_calls: [
            {
              tool_name: 'read',
              tool_call_id: 'cloud-call',
              parent_tool_call_id: 'cloud-run-code',
              tool_call_status: 2,
              tool_call_result_data: CHILD_RESULT,
            },
          ],
        },
      ],
      hasMore: true,
      nextCursor: 'older',
      lastMsgId: 'cloud-1',
    }));
    const result = await run(CHILD, { listMessages }, { session_id: 'cloud-session', source: 'cloud', limit: 5 });

    expect(listMessages).toHaveBeenCalledWith(
      { sessionId: 'cloud-session', source: 'cloud', limit: 5 },
      undefined,
    );
    expect(await responseOf(result)).toEqual({
      messages: [
        {
          msgId: 'cloud-1',
          role: 'assistant',
          msgContent: LONG_TEXT,
          msgType: 2,
          tool_calls: [
            {
              tool_name: 'read',
              tool_call_id: 'cloud-call',
              parent_tool_call_id: 'cloud-run-code',
              status: 'completed',
              result_chars: CHILD_RESULT.length,
            },
          ],
        },
      ],
      hasMore: true,
      nextCursor: 'older',
      lastMsgId: 'cloud-1',
    });
  });

  it('reads back multi-megabyte child results in a bounded response for direct and run_code calls', async () => {
    const huge = JSON.stringify({ content: [{ type: 'text', text: 'h'.repeat(24 * 1024 * 1024) }] });
    const messages = Array.from({ length: 10 }, (_, index) => ({
      msg_id: `msg-${index}`,
      role: 'assistant',
      msg_content: `turn ${index}`,
      tool_calls: [
        { tool_name: 'run_code', tool_call_id: `rc-${index}`, tool_call_status: 2, tool_call_result_data: '{}' },
        ...[0, 1].map((child) => ({
          tool_name: 'read',
          tool_call_id: `rc-${index}-child-${child}`,
          parent_tool_call_id: `rc-${index}`,
          tool_call_status: 2,
          tool_call_result_data: huge,
        })),
      ],
    }));
    const listMessages = async () => ({ messages });
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for (const context of [DIRECT, CHILD]) {
        for (const extra of [{}, { include_tool_outputs: true }]) {
          stringify.mockClear();
          const result = await run(context, { listMessages }, { session_id: 'mvs_target', limit: 10, ...extra });
          // 20 children of 24 MiB each: the response stays tens of KB and is never cut.
          expect(result.text.length).toBeLessThan(150_000);
          expect(result.text).not.toContain('output truncated');
          const calls = toolCalls(JSON.parse(result.text).response);
          expect(calls.filter((call) => call.result_chars === huge.length)).toHaveLength(20);
          // Nothing serialized a stored 24 MiB result on the way.
          const longest = Math.max(...stringify.mock.results.map((entry) => String(entry.value ?? '').length));
          expect(longest).toBeLessThan(150_000);
        }
      }
    } finally {
      stringify.mockRestore();
    }
  });
});

type ToolCallView = Record<string, unknown>;

/** Read as a run_code child: LONG_TEXT alone is over the 16,000-token cap of a direct call. */
async function read(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const listMessages = async () => ({ messages: storedMessages(), hasMore: false });
  return responseOf(await run(CHILD, { listMessages }, args));
}

async function responseOf(result: { text: string }): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(result.text) as { ok: boolean; response: Record<string, unknown> };
  expect(parsed.ok).toBe(true);
  return parsed.response;
}

function messageAt(response: Record<string, unknown>, index: number): Record<string, unknown> {
  return (response.messages as Record<string, unknown>[])[index] ?? {};
}

function toolCalls(response: Record<string, unknown>): ToolCallView[] {
  return (response.messages as Array<{ tool_calls?: ToolCallView[] }>).flatMap(
    (message) => message.tool_calls ?? [],
  );
}

function run(
  context: LocalRuntimeToolContext,
  overrides: Partial<LocalMavisSessionAdapter>,
  args: Record<string, unknown>,
) {
  const tool = new LocalMavisTool(agentAdapter(), undefined, sessionAdapter(overrides));
  return tool.execute(context, { command: 'session messages', args } as never);
}

function agentAdapter(): LocalMavisAgentAdapter {
  return {
    listAgents: async () => ({ agents: [] }),
    createAgent: async () => ({ name: 'created' }),
    getAgent: async ({ name }) => ({ agent: { name } }),
    updateAgent: async ({ name }) => ({ success: true, agent: { name } }),
    deleteAgent: async () => ({ success: true }),
    resolveAgentReadScope: async (requestedName) => ({ canonicalName: requestedName }),
    resolveAgentWriteTarget: async (requestedName) => requestedName,
    requireExactAgentKey: async (requestedName) => requestedName,
  };
}

function sessionAdapter(overrides: Partial<LocalMavisSessionAdapter>): LocalMavisSessionAdapter {
  return {
    listSessions: async () => ({ sessions: [] }),
    getSession: async ({ sessionId }) => ({ session: { sessionId } }),
    updateSession: async ({ sessionId }) => ({ success: true, session: { sessionId } }),
    listMessages: async () => ({ messages: [] }),
    sendSession: async ({ sessionId }) => ({
      sessionId,
      turnId: 'turn-default',
      status: 'completed',
      content: '',
    }),
    interruptSession: async () => ({ outcome: 'not_running' }),
    ...overrides,
  };
}
