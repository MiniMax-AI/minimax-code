import {
  readPtcChildExecutionDetails,
  readPtcExecutionDetails,
  type PtcExecutionDetails,
} from '@mavis/agent-core/tools';
import {
  sanitizePtcChildExecutionDetailsForSafety,
  sanitizePtcExecutionDetailsForSafety,
} from '@mavis/agent-tools/desktop';
import { logger } from '@mavis/shared/local-runtime-logging';
import type { CanonicalHistoryEnvelope } from '../../sessions/representation/canonical-history-contract.js';
import type { DisplayMessageRecord, MessageRepository } from '../repo/contract.js';
import type { SessionStreamWriter } from '../../stream/session-frame.js';
import { renderPtcExecutionEvidence } from './crash-recovery.js';

const WITHHELD_PROGRAM = {
  code: '/* Program source withheld after safety review. */',
  description: 'PTC execution evidence retained after safety review',
};

export function sanitizePtcSafetyHistoryMessage(
  message: CanonicalHistoryEnvelope['message'],
): CanonicalHistoryEnvelope['message'] | undefined {
  if (typeof message.timestamp !== 'number') {
    if (message.role === 'compactionSummary') return message;
    throw new TypeError('Canonical safety message timestamp is invalid.');
  }
  if (message.role === 'assistant') return safeAssistantMessage(message, message.timestamp);
  return safeToolResultMessage(message, message.timestamp);
}

function safeAssistantMessage(
  message: CanonicalHistoryEnvelope['message'],
  timestamp: number,
): CanonicalHistoryEnvelope['message'] | undefined {
  const calls = Array.isArray(message.content) ? message.content.filter(isToolCall) : [];
  if (calls.length === 0) return undefined;
  return {
    ...pickFields(message, ['api', 'provider', 'model', 'usage', 'stopReason']),
    role: 'assistant',
    timestamp,
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: call.name === 'run_code' ? { ...WITHHELD_PROGRAM } : call.arguments,
    })),
  };
}

function safeToolResultMessage(
  message: CanonicalHistoryEnvelope['message'],
  timestamp: number,
): CanonicalHistoryEnvelope['message'] {
  const details = readPtcExecutionDetails(message);
  if (!details && !(message.role === 'toolResult' && message.toolName === 'run_code'))
    return message;
  const safe = details ? safeOuterDetails(details) : undefined;
  return {
    ...pickFields(message, ['toolCallId', 'toolName', 'isError', 'timestamp']),
    role: 'toolResult',
    timestamp,
    content: [
      {
        type: 'text',
        text:
          safe?.host_forced_content ??
          'PTC output was withheld after safety review. Execution facts are unavailable; verify effects before retrying.',
      },
    ],
    ...(safe ? { details: { ptc: safe } } : {}),
  };
}

/**
 * Old display metadata must not reintroduce rejected text on a later restart.
 * @internal Exported for focused tests.
 */
export function sanitizePtcSafetyDisplayMessage(
  message: DisplayMessageRecord,
): DisplayMessageRecord | undefined {
  if (!Array.isArray(message.tool_calls)) return undefined;
  const calls = message.tool_calls.filter(isRecord);
  if (calls.length === 0) return undefined;
  return {
    ...pickFields(message, [
      'msg_id',
      'canonical_message_id',
      'role',
      'turn_id',
      'turnId',
      'meta',
      'timestamp',
      'created_at',
      'source',
      'sourceContext',
      'kind',
      'query_key',
    ]),
    msg_content: '',
    thinking_content: '',
    tool_calls: calls.map(safeDisplayCall),
  };
}

function safeDisplayCall(call: Record<string, unknown>): Record<string, unknown> {
  if (call.tool_name !== 'run_code' && !call.parent_tool_call_id) return call;
  const result = readJsonRecord(call.tool_call_result_data);
  const child = readPtcChildExecutionDetails({
    tool_call_id: call.tool_call_id,
    parent_tool_call_id: call.parent_tool_call_id,
    result,
  });
  const outer = readPtcExecutionDetails({
    role: 'toolResult',
    toolName: call.tool_name,
    details: result?.details,
  });
  const safeChild = child ? sanitizePtcChildExecutionDetailsForSafety(child) : undefined;
  const safeOuter = outer ? safeOuterDetails(outer) : undefined;
  const identity = pickFields(call, [
    'tool_name',
    'tool_call_id',
    'parent_tool_call_id',
    'tool_call_status',
    'tool_call_duration_ms',
    'plugin_provenances',
    'outcome_unknown',
  ]);
  return {
    ...identity,
    tool_call_args: JSON.stringify(
      call.tool_name === 'run_code' ? WITHHELD_PROGRAM : (safeChild?.record.input ?? {}),
    ),
    tool_call_result_data: JSON.stringify({
      content: [
        {
          type: 'text',
          text:
            safeOuter?.host_forced_content ??
            'PTC output was withheld after safety review. Host execution facts were retained.',
        },
      ],
      ...(safeChild ? { details: { ptc_child: safeChild } } : {}),
      ...(safeOuter ? { details: { ptc: safeOuter } } : {}),
    }),
  };
}

export async function projectPtcSafetyDisplay(
  messages: Pick<MessageRepository, 'listTurn' | 'upsert' | 'rewind'>,
  stream: Pick<SessionStreamWriter, 'write'>,
  context: { readonly sessionId: string; readonly turnId: string },
): Promise<void> {
  const display = await messages.listTurn(context.sessionId, context.turnId);
  const assistants = display.filter((message) => message.role === 'assistant');
  const deletedIds: string[] = [];
  const safeMessages: DisplayMessageRecord[] = [];
  for (const message of assistants) {
    const safe = sanitizePtcSafetyDisplayMessage(message);
    if (!safe) {
      if (message.msg_id) deletedIds.push(message.msg_id);
      continue;
    }
    await messages.upsert({ sessionId: context.sessionId, turnId: context.turnId, message: safe });
    safeMessages.push(safe);
  }
  if (deletedIds.length > 0)
    await messages.rewind({ sessionId: context.sessionId, messageIds: deletedIds });
  // Remove stale streamed text before publishing the same stable PTC rows.
  const messageIds = assistants.flatMap((message) => (message.msg_id ? [message.msg_id] : []));
  stream.write({
    identity: `messages-rewound:${context.turnId}:safety`,
    sessionId: context.sessionId,
    turnId: context.turnId,
    kind: 'messages-rewound',
    data: { messageIds },
  });
  if (safeMessages.length > 0)
    stream.write({
      identity: `messages-committed:${context.turnId}:safety`,
      sessionId: context.sessionId,
      turnId: context.turnId,
      kind: 'message-committed',
      data: { messages: safeMessages },
    });
  logPtcSafetyReconcile(context, assistants.length, safeMessages, deletedIds.length);
}

/**
 * One `ptc safety reconcile` line per PTC Turn stopped by safety review (the
 * only producer of this operation): how many display rows kept their PTC
 * execution evidence and how many were removed. Counts only, never text.
 */
function logPtcSafetyReconcile(
  context: { readonly sessionId: string; readonly turnId: string },
  assistantRows: number,
  keptRows: readonly DisplayMessageRecord[],
  removedRows: number,
): void {
  try {
    const keptCalls = keptRows.reduce(
      (count, row) => count + (Array.isArray(row.tool_calls) ? row.tool_calls.length : 0),
      0,
    );
    let outcome: 'evidence_kept' | 'all_removed' | 'nothing_to_reconcile' = 'evidence_kept';
    if (keptRows.length === 0) outcome = removedRows > 0 ? 'all_removed' : 'nothing_to_reconcile';
    logger.info(
      {
        session_id: context.sessionId,
        turn_id: context.turnId,
        outcome,
        assistant_rows: assistantRows,
        kept_rows: keptRows.length,
        kept_tool_calls: keptCalls,
        removed_rows: removedRows,
      },
      'ptc safety reconcile',
    );
  } catch {
    // Diagnostics must not affect the safety projection.
  }
}

function safeOuterDetails(details: PtcExecutionDetails): PtcExecutionDetails {
  const safe = sanitizePtcExecutionDetailsForSafety(details);
  return { ...safe, host_forced_content: renderPtcExecutionEvidence(safe, 'safety-review') };
}

function pickFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((field) => (value[field] === undefined ? [] : [[field, value[field]]])),
  );
}

function isToolCall(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === 'toolCall' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return isRecord(value) ? value : undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
