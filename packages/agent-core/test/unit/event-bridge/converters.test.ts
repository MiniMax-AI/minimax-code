import { describe, it, expect } from 'vitest';
import {
  buildAbortedTerminalStatusEvent,
  buildCompletedAssistantMessage,
  buildCompletedTerminalStatusEvent,
  buildDebugTraceEvent,
  buildFailedTerminalStatusEvent,
  buildFinishChunk,
  buildRunningSessionStatusEvent,
  buildStreamRespEvent,
  buildTextDeltaChunk,
  buildThinkingDeltaChunk,
  buildToolCallChunk,
  extractAssistantErrorMessage,
  extractAssistantStopReason,
  extractAssistantText,
  extractAssistantThinking,
  extractAssistantToolCalls,
  extractAssistantUsage,
  extractDeltaUpdate,
  extractFinalAssistantText,
  extractFinalAssistantUsageFromBuffer,
  isAssistantError,
  toolCallFromRuntime,
} from '../../../src/event-bridge/converters.js';
import { MsgType, RespDataType, ToolCallStatus } from '../../../src/protocol/agent-message.js';
import { RUNTIME_EVENT_SCHEMA } from '../../../src/protocol/runtime-event.js';
import { buildRuntimeWarningEvent } from '../../../src/event-bridge/runtime-warning.js';
import type { RuntimeEvent, StreamRespEvent } from '../../../src/protocol/runtime-event.js';
import {
  ProtocolErrorCode,
  RuntimeDebugTraceLevel,
  RuntimeEventStatus,
  RuntimeEventType,
  RuntimeStopReasonType,
} from '@mavis/protocol';

const fixture = {
  sessionId: 'sess-1',
  turnId: 'turn-1',
  msgId: 'msg-1',
  nowMs: 1_700_000_000_000,
};

describe('event-bridge/converters: extractDeltaUpdate', () => {
  it('returns text delta for text_delta event', () => {
    expect(extractDeltaUpdate({ type: 'text_delta', delta: 'hello', contentIndex: 0 })).toEqual({
      kind: 'text',
      delta: 'hello',
    });
  });

  it('returns thinking delta for thinking_delta event', () => {
    expect(
      extractDeltaUpdate({ type: 'thinking_delta', delta: 'hmm', contentIndex: 0 }),
    ).toEqual({
      kind: 'thinking',
      delta: 'hmm',
    });
  });

  it('returns undefined for unrelated event types', () => {
    expect(extractDeltaUpdate({ type: 'start' })).toBeUndefined();
    expect(extractDeltaUpdate({ type: 'tool_call_start', delta: 'x' })).toBeUndefined();
  });

  it('returns undefined when payload is not an object', () => {
    expect(extractDeltaUpdate(null)).toBeUndefined();
    expect(extractDeltaUpdate(undefined)).toBeUndefined();
    expect(extractDeltaUpdate('text_delta')).toBeUndefined();
    expect(extractDeltaUpdate(42)).toBeUndefined();
  });

  it('returns undefined when delta is not a string', () => {
    expect(extractDeltaUpdate({ type: 'text_delta', delta: 42 })).toBeUndefined();
  });
});

describe('event-bridge/converters: extractAssistantText / Thinking / ToolCalls', () => {
  it('joins all text blocks into a single string', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
        { type: 'thinking', thinking: 'hidden' },
      ],
    };
    expect(extractAssistantText(message)).toBe('Hello world');
  });

  it('returns empty string when content is missing or non-array', () => {
    expect(extractAssistantText({})).toBe('');
    expect(extractAssistantText(null)).toBe('');
    expect(extractAssistantText({ content: 42 })).toBe('');
  });

  it('returns string content directly when content is a string', () => {
    expect(extractAssistantText({ content: 'plain string' })).toBe('plain string');
  });

  it('joins all thinking blocks', () => {
    const message = {
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'visible' },
        { type: 'thinking', thinking: ' more' },
      ],
    };
    expect(extractAssistantThinking(message)).toBe('plan more');
  });

  it('returns empty thinking when content is a string (no thinking blocks)', () => {
    expect(extractAssistantThinking({ content: 'plain' })).toBe('');
  });

  it('extracts toolCall blocks into RuntimeToolCall[]', () => {
    const message = {
      content: [
        { type: 'text', text: 'plan' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/x' } },
        { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'ls' } },
      ],
    };
    expect(extractAssistantToolCalls(message)).toEqual([
      { tool_name: 'read', tool_call_id: 'call-1', status: 'started', args: { path: '/x' } },
      { tool_name: 'bash', tool_call_id: 'call-2', status: 'started', args: { command: 'ls' } },
    ]);
  });

  it('omits args field when arguments is missing or not an object', () => {
    const message = {
      content: [
        { type: 'toolCall', id: 'call-1', name: 'noop' },
        { type: 'toolCall', id: 'call-2', name: 'foo', arguments: 'bad-args' },
      ],
    };
    expect(extractAssistantToolCalls(message)).toEqual([
      { tool_name: 'noop', tool_call_id: 'call-1', status: 'started' },
      { tool_name: 'foo', tool_call_id: 'call-2', status: 'started' },
    ]);
  });

  it('returns empty list for invalid input', () => {
    expect(extractAssistantToolCalls(null)).toEqual([]);
    expect(extractAssistantToolCalls({ content: 'not array' })).toEqual([]);
    expect(extractAssistantToolCalls({ content: [{ type: 'toolCall', id: 42 }] })).toEqual([]);
  });
});

describe('event-bridge/converters: isAssistantError / extractAssistantErrorMessage / extractAssistantStopReason', () => {
  it('isAssistantError true when role=assistant and stopReason=error', () => {
    expect(isAssistantError({ role: 'assistant', stopReason: 'error' })).toBe(true);
  });

  it('isAssistantError false when stopReason !== error', () => {
    expect(isAssistantError({ role: 'assistant', stopReason: 'stop' })).toBe(false);
  });

  it('isAssistantError false when role !== assistant', () => {
    expect(isAssistantError({ role: 'user', stopReason: 'error' })).toBe(false);
  });

  it('isAssistantError false for invalid input', () => {
    expect(isAssistantError(null)).toBe(false);
    expect(isAssistantError(undefined)).toBe(false);
    expect(isAssistantError('not-a-message')).toBe(false);
  });

  it('extractAssistantErrorMessage returns string when present', () => {
    expect(extractAssistantErrorMessage({ errorMessage: 'rate limited' })).toBe('rate limited');
  });

  it('extractAssistantErrorMessage returns undefined when missing', () => {
    expect(extractAssistantErrorMessage({})).toBeUndefined();
    expect(extractAssistantErrorMessage(null)).toBeUndefined();
    expect(extractAssistantErrorMessage({ errorMessage: '' })).toBeUndefined();
  });

  it('extractAssistantStopReason returns string when present', () => {
    expect(extractAssistantStopReason({ stopReason: 'stop' })).toBe('stop');
    expect(extractAssistantStopReason({ stopReason: 'toolUse' })).toBe('toolUse');
  });

  it('extractAssistantStopReason returns undefined when missing or empty', () => {
    expect(extractAssistantStopReason({})).toBeUndefined();
    expect(extractAssistantStopReason({ stopReason: '' })).toBeUndefined();
    expect(extractAssistantStopReason(null)).toBeUndefined();
  });
});

describe('event-bridge/converters: toolCallFromRuntime', () => {
  it('maps started status to ToolCallStatus.Start', () => {
    expect(
      toolCallFromRuntime({
        tool_name: 'bash',
        tool_call_id: 'c1',
        status: 'started',
        args: { command: 'ls' },
      }),
    ).toEqual({
      tool_name: 'bash',
      tool_call_id: 'c1',
      tool_call_status: ToolCallStatus.Start,
      tool_call_args: '{"command":"ls"}',
    });
  });

  it('maps completed status to ToolCallStatus.Finished and serialises result', () => {
    expect(
      toolCallFromRuntime({
        tool_name: 'read',
        tool_call_id: 'c2',
        status: 'completed',
        result: { lines: 10 },
      }),
    ).toEqual({
      tool_name: 'read',
      tool_call_id: 'c2',
      tool_call_status: ToolCallStatus.Finished,
      tool_call_result_data: '{"lines":10}',
    });
  });

  it('maps failed status to ToolCallStatus.Failed and wraps error', () => {
    const out = toolCallFromRuntime({
      tool_name: 'bash',
      tool_call_id: 'c3',
      status: 'failed',
      error: { code: ProtocolErrorCode.INTERNAL_ERROR, message: 'boom' },
    });
    expect(out.tool_call_status).toBe(ToolCallStatus.Failed);
    expect(out.tool_call_result_data).toBe('{"error":{"code":50001,"message":"boom"}}');
  });

  it('maps `running` status defensively to Start', () => {
    expect(toolCallFromRuntime({ tool_name: 'x', tool_call_id: 'c', status: 'running' })).toEqual({
      tool_name: 'x',
      tool_call_id: 'c',
      tool_call_status: ToolCallStatus.Start,
    });
  });

  it('serialises duration_ms onto tool_call_duration_ms when present', () => {
    expect(
      toolCallFromRuntime({
        tool_name: 'read',
        tool_call_id: 'c4',
        status: 'completed',
        result: { lines: 1 },
        duration_ms: 321,
      }),
    ).toEqual({
      tool_name: 'read',
      tool_call_id: 'c4',
      tool_call_status: ToolCallStatus.Finished,
      tool_call_result_data: '{"lines":1}',
      tool_call_duration_ms: 321,
    });
  });

  it('omits tool_call_duration_ms when duration_ms is absent', () => {
    const out = toolCallFromRuntime({ tool_name: 'x', tool_call_id: 'c5', status: 'completed' });
    expect(out).not.toHaveProperty('tool_call_duration_ms');
  });

  it('strips inline image base64 from tool_call_result_data', () => {
    const bigBase64 = 'A'.repeat(3_500_000); // 3.5 MB base64 payload
    const result = toolCallFromRuntime({
      tool_name: 'read',
      tool_call_id: 'c-image',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'Read image file [image/png]' },
          { type: 'image', data: bigBase64, mimeType: 'image/png' },
        ],
        details: {},
      },
    });
    const decoded = JSON.parse(result.tool_call_result_data!);
    expect(decoded.content).toEqual([
      { type: 'text', text: 'Read image file [image/png]' },
    ]);
    expect(result.tool_call_result_data!.length).toBeLessThan(200);
  });

  it('strips inline video base64 (read tool image block with video/* mime)', () => {
    const bigBase64 = 'B'.repeat(12_000_000); // 12 MB video payload
    const result = toolCallFromRuntime({
      tool_name: 'read',
      tool_call_id: 'c-video',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'Read video file [video/mp4]' },
          { type: 'image', data: bigBase64, mimeType: 'video/mp4' },
        ],
        details: { media: { kind: 'video', mime_type: 'video/mp4', size_bytes: 9_000_000 } },
      },
    });
    const decoded = JSON.parse(result.tool_call_result_data!);
    expect(decoded.content).toEqual([
      { type: 'text', text: 'Read video file [video/mp4]' },
    ]);
    expect(decoded.details).toEqual({
      media: { kind: 'video', mime_type: 'video/mp4', size_bytes: 9_000_000 },
    });
    expect(result.tool_call_result_data!.length).toBeLessThan(400);
  });

  it('leaves text-only results untouched', () => {
    const out = toolCallFromRuntime({
      tool_name: 'bash',
      tool_call_id: 'c-bash',
      status: 'completed',
      result: { content: [{ type: 'text', text: 'hi' }], details: { ok: true } },
    });
    expect(out.tool_call_result_data).toBe(
      JSON.stringify({ content: [{ type: 'text', text: 'hi' }], details: { ok: true } }),
    );
  });

  it('does NOT mutate the original tc.result object (pi retains it for LLM ctx)', () => {
    const bigBase64 = 'C'.repeat(2_000_000);
    const original = {
      content: [
        { type: 'text', text: 'Read image file [image/jpeg]' },
        { type: 'image', data: bigBase64, mimeType: 'image/jpeg' },
      ],
      details: {},
    };
    toolCallFromRuntime({
      tool_name: 'read',
      tool_call_id: 'c-mut',
      status: 'completed',
      result: original,
    });
    expect(original.content).toHaveLength(2);
    expect((original.content[1] as { data: string }).data).toBe(bigBase64);
  });
});

describe('event-bridge/converters: stream-event builders', () => {
  it.each([undefined, 'system-message'])(
    'buildRuntimeWarningEvent preserves the optional category %s in a SystemEvent', (category) => {
    const event = buildRuntimeWarningEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'warning-1',
      runtimeSeq: 1,
      category,
      message: 'A Plugin Hook failed open.',
      source: 'plugin-hook',
      hookEvent: 'PreToolUse',
      nowMs: 123,
    });
    const envelope = JSON.parse(event.payload.stream_resp) as {
      type: number;
      agent_message: { msg_type: number; msg_content: string };
    };

    expect(envelope.type).toBe(RespDataType.AgentMessage);
    expect(envelope.agent_message.msg_type).toBe(MsgType.SystemEvent);
    expect(JSON.parse(envelope.agent_message.msg_content)).toEqual({
      eventType: 'runtime.warning',
      ...(category ? { category } : {}),
      message: 'A Plugin Hook failed open.',
      source: 'plugin-hook',
      hookEvent: 'PreToolUse',
    });
  });

  it('buildStreamRespEvent serialises RespData into payload.stream_resp', () => {
    const ev = buildStreamRespEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'evt-1',
      runtimeSeq: 7,
      respData: {
        type: RespDataType.AgentMessageChunk,
        agent_message_chunk: { msg_id: fixture.msgId, chunk_index: 0, msg_content: 'hi' },
      },
    });
    expect(ev.schema).toBe(RUNTIME_EVENT_SCHEMA);
    expect(ev.type).toBe(RuntimeEventType.STREAM_RESP);
    expect(ev.event_id).toBe('evt-1');
    expect(ev.runtime_seq).toBe(7);
    expect(typeof ev.payload.stream_resp).toBe('string');
    expect(ev.payload).toEqual({ stream_resp: ev.payload.stream_resp });
    const inner = JSON.parse(ev.payload.stream_resp!);
    expect(inner).toEqual({
      type: RespDataType.AgentMessageChunk,
      agent_message_chunk: { msg_id: fixture.msgId, chunk_index: 0, msg_content: 'hi' },
    });
    expect(inner).not.toHaveProperty('schema');
    expect(inner).not.toHaveProperty('event_id');
    expect(inner).not.toHaveProperty('payload');
  });

  it('buildTextDeltaChunk packs delta as msg_content with role=assistant', () => {
    const ev = buildTextDeltaChunk({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'evt-2',
      runtimeSeq: 1,
      msgId: fixture.msgId,
      chunkIndex: 0,
      delta: 'hello',
      nowMs: fixture.nowMs,
    });
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.type).toBe(RespDataType.AgentMessageChunk);
    expect(respData.agent_message_chunk.msg_content).toBe('hello');
    expect(respData.agent_message_chunk.role).toBe('assistant');
    expect(respData.agent_message_chunk.turn_id).toBe(fixture.turnId);
    expect(respData.agent_message_chunk.timestamp).toBe(fixture.nowMs);
  });

  it('buildThinkingDeltaChunk packs delta as thinking_content', () => {
    const ev = buildThinkingDeltaChunk({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'evt-3',
      runtimeSeq: 2,
      msgId: fixture.msgId,
      chunkIndex: 1,
      delta: 'thought',
      nowMs: fixture.nowMs,
    });
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.agent_message_chunk.thinking_content).toBe('thought');
    expect(respData.agent_message_chunk.msg_content).toBeUndefined();
  });

  it('buildToolCallChunk wraps a single RuntimeToolCall', () => {
    const ev = buildToolCallChunk({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'evt-4',
      runtimeSeq: 3,
      msgId: fixture.msgId,
      chunkIndex: 2,
      toolCall: {
        tool_name: 'read',
        tool_call_id: 'tc-1',
        status: 'started',
        args: { path: '/x' },
      },
      nowMs: fixture.nowMs,
    });
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.agent_message_chunk.tool_calls).toHaveLength(1);
    expect(respData.agent_message_chunk.tool_calls[0]).toEqual({
      tool_name: 'read',
      tool_call_id: 'tc-1',
      tool_call_status: ToolCallStatus.Start,
      tool_call_args: '{"path":"/x"}',
    });
  });

  it('buildFinishChunk emits a finish=true chunk with optional reason and thinking_duration_ms', () => {
    const ev = buildFinishChunk({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'evt-5',
      runtimeSeq: 4,
      msgId: fixture.msgId,
      chunkIndex: 3,
      finishReason: 'stop',
      thinkingDurationMs: 1234,
      nowMs: fixture.nowMs,
    });
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.agent_message_chunk.finish).toBe(true);
    expect(respData.agent_message_chunk.finish_reason).toBe('stop');
    expect(respData.agent_message_chunk.thinking_duration_ms).toBe(1234);
  });

  it('buildFinishChunk omits finish_reason and thinking_duration_ms when not provided', () => {
    const ev = buildFinishChunk({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'evt-6',
      runtimeSeq: 5,
      msgId: fixture.msgId,
      chunkIndex: 4,
      nowMs: fixture.nowMs,
    });
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.agent_message_chunk.finish).toBe(true);
    expect(respData.agent_message_chunk.finish_reason).toBeUndefined();
    expect(respData.agent_message_chunk.thinking_duration_ms).toBeUndefined();
  });

  it('buildCompletedAssistantMessage emits an AgentMessage with text/thinking/tools/usage', async () => {
    const ev = await buildCompletedAssistantMessage({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'evt-7',
      runtimeSeq: 6,
      msgId: fixture.msgId,
      text: 'final text',
      thinking: 'final thinking',
      thinkingDurationMs: 500,
      finishReason: 'stop',
      toolCalls: [{ tool_name: 'read', tool_call_id: 'tc-1', status: 'completed', result: 42 }],
      usage: { total_tokens: 100, context_window: 200_000 },
      nowMs: fixture.nowMs,
    });
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.type).toBe(RespDataType.AgentMessage);
    expect(respData.agent_message.msg_content).toBe('final text');
    expect(respData.agent_message.turn_id).toBe(fixture.turnId);
    expect(respData.agent_message.thinking_content).toBe('final thinking');
    expect(respData.agent_message.thinking_duration_ms).toBe(500);
    expect(respData.agent_message.finish_reason).toBe('stop');
    expect(respData.agent_message.tool_calls).toHaveLength(1);
    expect(respData.agent_message.tool_calls[0].tool_call_status).toBe(ToolCallStatus.Finished);
    expect(respData.agent_message.usage).toEqual({ total_tokens: 100, context_window: 200_000 });
  });

  it('buildCompletedAssistantMessage omits optional fields when missing', async () => {
    const ev = await buildCompletedAssistantMessage({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'evt-8',
      runtimeSeq: 7,
      msgId: fixture.msgId,
      text: 'plain',
      nowMs: fixture.nowMs,
    });
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.agent_message.thinking_content).toBeUndefined();
    expect(respData.agent_message.tool_calls).toBeUndefined();
    expect(respData.agent_message.usage).toBeUndefined();
    expect(respData.agent_message.thinking_duration_ms).toBeUndefined();
  });

  it('buildCompletedAssistantMessage applies respDataTransform when supplied', async () => {
    let captured: { sessionId: string; turnId: string } | undefined;
    const ev = await buildCompletedAssistantMessage(
      {
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        eventId: 'evt-9',
        runtimeSeq: 8,
        msgId: fixture.msgId,
        text: 'orig',
        nowMs: fixture.nowMs,
      },
      async (respData, ctx) => {
        captured = ctx;
        if (!respData.agent_message) return respData;
        return {
          ...respData,
          agent_message: { ...respData.agent_message, msg_content: 'rewritten' },
        };
      },
    );
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.agent_message.msg_content).toBe('rewritten');
    expect(captured).toEqual({ sessionId: fixture.sessionId, turnId: fixture.turnId });
  });

  it('buildCompletedAssistantMessage falls back to original RespData when transform throws', async () => {
    const ev = await buildCompletedAssistantMessage(
      {
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        eventId: 'evt-10',
        runtimeSeq: 9,
        msgId: fixture.msgId,
        text: 'unchanged',
        nowMs: fixture.nowMs,
      },
      () => {
        throw new Error('transform boom');
      },
    );
    const respData = JSON.parse(ev.payload.stream_resp!);
    expect(respData.agent_message.msg_content).toBe('unchanged');
  });
});

describe('event-bridge/converters: terminal pair builders', () => {
  it('buildRunningSessionStatusEvent returns running status', () => {
    const status = buildRunningSessionStatusEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 's-running',
    });
    expect(status.type).toBe(RuntimeEventType.SESSION_STATUS);
    expect(status.payload.status).toBe(RuntimeEventStatus.RUNNING);
    expect(status.payload.stop_reason).toBeUndefined();
  });

  it('buildCompletedTerminalStatusEvent returns completed status', () => {
    const status = buildCompletedTerminalStatusEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      statusEventId: 's-1',
    });
    expect(status.type).toBe(RuntimeEventType.SESSION_STATUS);
    expect(status.payload.status).toBe(RuntimeEventStatus.COMPLETED);
    expect(status.payload.stop_reason).toEqual({ type: RuntimeStopReasonType.END_TURN });
  });

  it('buildCompletedTerminalStatusEvent includes optional usage when supplied', () => {
    const status = buildCompletedTerminalStatusEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      statusEventId: 's-1',
      terminalUsage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    });
    expect(status.payload.usage).toEqual({ input_tokens: 10, output_tokens: 20, total_tokens: 30 });
  });

  it('buildAbortedTerminalStatusEvent returns aborted status', () => {
    const status = buildAbortedTerminalStatusEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      statusEventId: 's-2',
    });
    expect(status.payload.status).toBe(RuntimeEventStatus.ABORTED);
    expect(status.payload.stop_reason).toEqual({
      type: RuntimeStopReasonType.ABORT,
      message: 'aborted',
    });
  });

  it('buildFailedTerminalStatusEvent packs message into stop_reason and protocol error', () => {
    const status = buildFailedTerminalStatusEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      statusEventId: 's-3',
      message: 'kaboom',
    });
    expect(status.payload.status).toBe(RuntimeEventStatus.FAILED);
    expect(status.payload.stop_reason).toEqual({
      type: RuntimeStopReasonType.ERROR,
      message: 'kaboom',
    });
    expect(status.payload.error).toEqual({ code: ProtocolErrorCode.INTERNAL_ERROR, message: 'kaboom' });
  });

  it('buildFailedTerminalStatusEvent forwards explicit protocol error code', () => {
    const status = buildFailedTerminalStatusEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      statusEventId: 's-4',
      message: 'denied',
      error: { code: ProtocolErrorCode.INTERNAL_ERROR, message: 'denied' },
    });
    expect(status.payload.error?.code).toBe(ProtocolErrorCode.INTERNAL_ERROR);
  });
});

describe('event-bridge/converters: buildDebugTraceEvent', () => {
  it('packs phase + level + attrs + duration_ms (attrs JSON-stringified into attrs_json)', () => {
    const ev = buildDebugTraceEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'dbg-1',
      phase: 'tool_call_started',
      message: 'started',
      level: 'info',
      attrs: { tool: 'read', n: 1, flag: true },
      durationMs: 42,
    });
    expect(ev.type).toBe(RuntimeEventType.DEBUG_TRACE);
    expect(ev.payload).toBeDefined();
    if (ev.type === RuntimeEventType.DEBUG_TRACE) {
      expect(ev.payload.trace!.phase).toBe('tool_call_started');
      expect(ev.payload.trace!.level).toBe(RuntimeDebugTraceLevel.INFO);
      expect(ev.payload.trace!.message).toBe('started');
      expect(JSON.parse(ev.payload.trace!.attrs_json!)).toEqual({
        tool: 'read',
        n: 1,
        flag: true,
      });
      expect(ev.payload.trace!.duration_ms).toBe(42);
    }
  });

  it('defaults level to debug', () => {
    const ev = buildDebugTraceEvent({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      eventId: 'dbg-2',
      phase: 'phase-x',
      message: 'msg',
    });
    if (ev.type === RuntimeEventType.DEBUG_TRACE) {
      expect(ev.payload.trace!.level).toBe(RuntimeDebugTraceLevel.DEBUG);
      expect(ev.payload.trace!.duration_ms).toBeUndefined();
    }
  });
});

describe('extractAssistantUsage', () => {
  it('returns undefined for non-object input', () => {
    expect(extractAssistantUsage(undefined, 200_000)).toBeUndefined();
    expect(extractAssistantUsage(null, 200_000)).toBeUndefined();
    expect(extractAssistantUsage(42, 200_000)).toBeUndefined();
  });

  it('returns undefined when message role is not assistant', () => {
    expect(extractAssistantUsage({ role: 'user', usage: { totalTokens: 100 } }, 200_000)).toBeUndefined();
  });

  it('returns undefined when stopReason is aborted or error (pi suppresses usage)', () => {
    expect(
      extractAssistantUsage(
        { role: 'assistant', stopReason: 'aborted', usage: { totalTokens: 100 } },
        200_000,
      ),
    ).toBeUndefined();
    expect(
      extractAssistantUsage(
        { role: 'assistant', stopReason: 'error', usage: { totalTokens: 100 } },
        200_000,
      ),
    ).toBeUndefined();
  });

  it('returns undefined when usage block is missing', () => {
    expect(extractAssistantUsage({ role: 'assistant' }, 200_000)).toBeUndefined();
    expect(extractAssistantUsage({ role: 'assistant', usage: null }, 200_000)).toBeUndefined();
  });

  it('prefers totalTokens over input+output+cacheRead+cacheWrite', () => {
    const result = extractAssistantUsage(
      {
        role: 'assistant',
        stopReason: 'end_turn',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 999 },
      },
      200_000,
    );
    expect(result).toEqual({
      total_tokens: 999,
      context_window: 200_000,
      input_tokens: 100,
      output_tokens: 50,
    });
  });

  it('falls back to input+output+cacheRead+cacheWrite when totalTokens is missing or zero', () => {
    const result = extractAssistantUsage(
      {
        role: 'assistant',
        stopReason: 'end_turn',
        usage: { input: 100, output: 50, cacheRead: 30, cacheWrite: 20 },
      },
      200_000,
    );
    // Cache hits/writes are also surfaced so observability can distinguish
    // a true zero from "provider did not report cache stats".
    expect(result).toEqual({
      total_tokens: 200,
      context_window: 200_000,
      input_tokens: 100,
      output_tokens: 50,
      cache_read: 30,
      cache_write: 20,
    });
  });

  it('uses caller-provided contextWindow (per-model metadata)', () => {
    const result = extractAssistantUsage(
      { role: 'assistant', usage: { totalTokens: 500 } },
      131_072,
    );
    expect(result?.context_window).toBe(131_072);
  });

  it('coerces non-finite usage values to 0', () => {
    const result = extractAssistantUsage(
      {
        role: 'assistant',
        usage: { input: NaN, output: 'oops', cacheRead: 30, cacheWrite: 20 },
      },
      200_000,
    );
    // input/output coerce to 0 but valid cacheRead/cacheWrite still surface.
    expect(result).toEqual({
      total_tokens: 50,
      context_window: 200_000,
      cache_read: 30,
      cache_write: 20,
    });
  });

  it('keeps an explicit zero input or output instead of dropping the field', () => {
    // Full prompt-cache hits report input: 0 alongside cacheRead. Dropping the
    // zero makes downstream usage summaries treat a known count as unknown and
    // flag the turn incomplete, so explicit finite zeros must survive.
    const result = extractAssistantUsage(
      {
        role: 'assistant',
        stopReason: 'end_turn',
        usage: { input: 0, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 70 },
      },
      200_000,
    );
    expect(result).toEqual({
      total_tokens: 70,
      context_window: 200_000,
      input_tokens: 0,
      output_tokens: 20,
      cache_read: 50,
    });
  });

  it('still omits input and output when the provider did not report them', () => {
    const result = extractAssistantUsage(
      { role: 'assistant', stopReason: 'end_turn', usage: { totalTokens: 500 } },
      200_000,
    );
    expect(result).toEqual({ total_tokens: 500, context_window: 200_000 });
  });
});

// ─── Buffer-walk helpers (sub-agent extraction) ─────────────────────────

/** Build a minimal `stream.resp` RuntimeEvent from a serialised RespData. */
function fakeStreamResp(respData: object): StreamRespEvent {
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: 'ev-fake',
    session_id: fixture.sessionId,
    turn_id: fixture.turnId,
    runtime_seq: 0,
    type: RuntimeEventType.STREAM_RESP,
    payload: { stream_resp: JSON.stringify(respData) },
  };
}

describe('extractFinalAssistantText (buffer-walk helper)', () => {
  it('returns the AgentMessage msg_content even when followed by tool-call chunks', () => {
    const buffered: RuntimeEvent[] = [
      // [0] AgentMessageChunk with partial text
      fakeStreamResp({
        type: RespDataType.AgentMessageChunk,
        agent_message_chunk: { msg_id: 'msg-1', chunk_index: 0, msg_content: 'partial' },
      }),
      // [1] Completed AgentMessage with final text
      fakeStreamResp({
        type: RespDataType.AgentMessage,
        agent_message: {
          msg_id: 'msg-1',
          msg_type: MsgType.AgentContent,
          role: 'assistant',
          msg_content: 'FINAL TEXT',
          timestamp: fixture.nowMs,
        },
      }),
      // [2] AgentMessageChunk with tool_calls (arrives after the closed message)
      fakeStreamResp({
        type: RespDataType.AgentMessageChunk,
        agent_message_chunk: {
          msg_id: 'msg-1',
          chunk_index: 1,
          tool_calls: [{ tool_name: 'bash', tool_call_id: 'tc-1', tool_call_status: 1 }],
        },
      }),
      // [3] terminal session.status
      {
        schema: RUNTIME_EVENT_SCHEMA,
        event_id: 'ev-term',
        session_id: fixture.sessionId,
        turn_id: fixture.turnId,
        type: RuntimeEventType.SESSION_STATUS,
        payload: {
          status: RuntimeEventStatus.COMPLETED,
          stop_reason: { type: RuntimeStopReasonType.END_TURN },
        },
      } as RuntimeEvent,
    ];

    expect(extractFinalAssistantText(buffered)).toBe('FINAL TEXT');
  });

  it('returns empty string when buffer has no AgentMessage frame', () => {
    const buffered: RuntimeEvent[] = [
      fakeStreamResp({
        type: RespDataType.AgentMessageChunk,
        agent_message_chunk: { msg_id: 'msg-1', chunk_index: 0, msg_content: 'chunk only' },
      }),
      fakeStreamResp({
        type: RespDataType.AgentMessageChunk,
        agent_message_chunk: { msg_id: 'msg-1', chunk_index: 1, finish: true },
      }),
      {
        schema: RUNTIME_EVENT_SCHEMA,
        event_id: 'ev-term',
        session_id: fixture.sessionId,
        turn_id: fixture.turnId,
        type: RuntimeEventType.SESSION_STATUS,
        payload: {
          status: RuntimeEventStatus.COMPLETED,
          stop_reason: { type: RuntimeStopReasonType.END_TURN },
        },
      } as RuntimeEvent,
    ];

    expect(extractFinalAssistantText(buffered)).toBe('');
  });
});

describe('extractFinalAssistantUsageFromBuffer', () => {
  it('returns usage from the last AgentMessage', () => {
    const buffered: RuntimeEvent[] = [
      fakeStreamResp({
        type: RespDataType.AgentMessage,
        agent_message: {
          msg_id: 'msg-1',
          msg_type: MsgType.AgentContent,
          role: 'assistant',
          msg_content: 'done',
          timestamp: fixture.nowMs,
          usage: { total_tokens: 500, context_window: 200_000 },
        },
      }),
    ];

    expect(extractFinalAssistantUsageFromBuffer(buffered)).toEqual({
      total_tokens: 500,
      context_window: 200_000,
    });
  });

  it('returns undefined when buffer has no AgentMessage', () => {
    const buffered: RuntimeEvent[] = [
      fakeStreamResp({
        type: RespDataType.AgentMessageChunk,
        agent_message_chunk: { msg_id: 'msg-1', chunk_index: 0 },
      }),
    ];

    expect(extractFinalAssistantUsageFromBuffer(buffered)).toBeUndefined();
  });

  // Regression: sub-agent buffer path (cloud-task.ts:207) must propagate
  // cache_read / cache_write so sub-agent cache metrics aren't silently
  // dropped — symmetric with extractAssistantUsage on the direct event path.
  it('propagates cache_read / cache_write when present in usage', () => {
    const buffered: RuntimeEvent[] = [
      fakeStreamResp({
        type: RespDataType.AgentMessage,
        agent_message: {
          msg_id: 'msg-1',
          msg_type: MsgType.AgentContent,
          role: 'assistant',
          msg_content: 'done',
          timestamp: fixture.nowMs,
          usage: {
            total_tokens: 1500,
            context_window: 200_000,
            cache_read: 800,
            cache_write: 200,
          },
        },
      }),
    ];

    expect(extractFinalAssistantUsageFromBuffer(buffered)).toEqual({
      total_tokens: 1500,
      context_window: 200_000,
      cache_read: 800,
      cache_write: 200,
    });
  });

  it('omits cache_read / cache_write when zero or missing', () => {
    const buffered: RuntimeEvent[] = [
      fakeStreamResp({
        type: RespDataType.AgentMessage,
        agent_message: {
          msg_id: 'msg-1',
          msg_type: MsgType.AgentContent,
          role: 'assistant',
          msg_content: 'done',
          timestamp: fixture.nowMs,
          usage: {
            total_tokens: 500,
            context_window: 200_000,
            cache_read: 0,
            cache_write: 0,
          },
        },
      }),
    ];

    expect(extractFinalAssistantUsageFromBuffer(buffered)).toEqual({
      total_tokens: 500,
      context_window: 200_000,
    });
  });
});
