import {
  readPtcChildExecutionDetails,
  type PtcChildExecutionDetails,
  type PtcExecutionDetails,
  type PtcRetainedFact,
  type PtcToolCallRecord,
} from '@mavis/agent-core/tools';
import { logger } from '@mavis/shared/local-runtime-logging';

import type { SessionSystemCanonicalHistoryProvider } from '../history/canonical-history-provider.js';
import type { DisplayMessageRecord, MessageRepository } from '../repo/contract.js';

const OUTCOME_UNKNOWN_CODE = 'PTC_OUTCOME_UNKNOWN';
const OUTER_INTERRUPTED_CODE = 'PTC_INTERRUPTED_BY_RUNTIME_RESTART';
const OUTCOME_UNKNOWN_MESSAGE =
  'This tool call was interrupted by a local runtime restart. Its result is unknown and must not be replayed automatically.';
const OUTER_INTERRUPTED_MESSAGE =
  'This PTC program was interrupted because the previous local runtime stopped. Known child results were preserved; unknown child calls must not be replayed automatically.';
const MAX_PTC_RECOVERY_SUMMARY_BYTES = 64 * 1024;
const MAX_PTC_RECOVERY_INPUT_BYTES = 2 * 1024;

/** Durable terminal fact emitted by the existing Turn lease recovery. */
export interface PtcCrashRecoveryTerminalFact {
  readonly sessionId: string;
  readonly turnId: string;
  readonly completedAtMs: number;
  readonly outcome: 'failed';
}

export interface PtcCrashRecoveryInput {
  readonly processStartedAtMs: number;
  readonly interruptedSessionIds: readonly string[];
  readonly terminalFacts?: readonly PtcCrashRecoveryTerminalFact[];
}

export interface PtcCrashRecoveryResult {
  readonly recoveredTurnIds: readonly string[];
}

export interface PtcCrashRecoveryOptions {
  readonly messages: Pick<MessageRepository, 'list' | 'upsert'>;
  readonly history: Pick<SessionSystemCanonicalHistoryProvider, 'readActive' | 'append'>;
}

interface DisplayToolCall extends Record<string, unknown> {
  readonly tool_name: string;
  readonly tool_call_id: string;
  readonly tool_call_status: number;
}

interface PtcParent {
  readonly id: string;
  readonly turnId?: string;
}

interface PendingCanonicalToolCall {
  readonly id: string;
  readonly name: string;
}

interface PendingCanonicalRound {
  readonly calls: readonly PendingCanonicalToolCall[];
}

interface RecoveredPtcChild {
  readonly record: PtcToolCallRecord;
  readonly retainedFacts: readonly PtcRetainedFact[];
}

/**
 * Reconciles only evidence that survived in the existing display Message
 * rows. It never resumes a Worker, invokes a tool, or infers a call from JS.
 * A synthetic outer ToolResult closes Pi's pending `run_code` round so the
 * next turn can consume the preserved PTC facts rather than silently dropping
 * them through canonical-history recovery.
 */
export async function recoverPtcCrashState(
  options: PtcCrashRecoveryOptions,
  input: PtcCrashRecoveryInput,
): Promise<PtcCrashRecoveryResult> {
  const terminalFacts = input.terminalFacts ?? [];
  const terminalFactsBySession = groupTerminalFacts(terminalFacts);
  const recoveredTurnIds: string[] = [];
  const summary = { sessions: 0, programs: 0, closed_calls: 0 };
  const outcomes: Partial<Record<SessionRecovery['outcome'], number>> = {};
  for (const sessionId of new Set([
    ...input.interruptedSessionIds,
    ...terminalFacts.map((fact) => fact.sessionId),
  ])) {
    const recovered = await recoverSessionPtcCrashState(options, {
      sessionId,
      processStartedAtMs: input.processStartedAtMs,
      terminalFacts: terminalFactsBySession.get(sessionId) ?? [],
    });
    summary.sessions += 1;
    outcomes[recovered.outcome] = (outcomes[recovered.outcome] ?? 0) + 1;
    if (recovered.outcome !== 'recovered') continue;
    recoveredTurnIds.push(recovered.turnId);
    summary.programs += recovered.programs;
    summary.closed_calls += recovered.closedCalls;
  }
  logPtcCrashRecovery(summary, outcomes, recoveredTurnIds);
  return { recoveredTurnIds };
}

/**
 * At most one `ptc crash recovery` line per recovery call, written only when
 * a run_code was closed or a pending one could not be matched to its Turn:
 * how many programs were closed and why the others were left alone. Startup
 * recovery runs once per batch of stale Sessions and once more for the
 * terminal facts, so the second pass usually finds the same Session already
 * closed (`no_pending_round`); writing that would duplicate the line and
 * double-count sessions, so calls with only `no_ptc_parent` or
 * `no_pending_round` write nothing.
 */
function logPtcCrashRecovery(
  summary: { readonly sessions: number; readonly programs: number; readonly closed_calls: number },
  outcomes: Partial<Record<SessionRecovery['outcome'], number>>,
  recoveredTurnIds: readonly string[],
): void {
  if ((outcomes.recovered ?? 0) === 0 && (outcomes.unmatched ?? 0) === 0) return;
  try {
    logger.info(
      { ...summary, recovered_turn_ids: recoveredTurnIds, outcomes },
      'ptc crash recovery',
    );
  } catch {
    // Diagnostics must not affect startup recovery.
  }
}

type SessionRecovery =
  | {
      readonly outcome: 'recovered';
      readonly turnId: string;
      readonly programs: number;
      readonly closedCalls: number;
    }
  /** No run_code in the display rows, or none still pending in canonical history. */
  | { readonly outcome: 'no_ptc_parent' | 'no_pending_round' }
  /** A pending run_code whose Turn has no terminal fact to close it with. */
  | { readonly outcome: 'unmatched' };

async function recoverSessionPtcCrashState(
  options: PtcCrashRecoveryOptions,
  input: {
    readonly sessionId: string;
    readonly processStartedAtMs: number;
    readonly terminalFacts: readonly PtcCrashRecoveryTerminalFact[];
  },
): Promise<SessionRecovery> {
  const listed = await options.messages.list(input.sessionId);
  const parents = findPtcParents(listed.messages);
  if (parents.length === 0) return { outcome: 'no_ptc_parent' };
  const pendingRound = findPendingCanonicalRound(
    (await options.history.readActive(input.sessionId)).messages,
  );
  if (!pendingRound || pendingRound.calls.length === 0) return { outcome: 'no_pending_round' };

  const pendingParentIds = new Set(
    pendingRound.calls.filter((call) => call.name === 'run_code').map((call) => call.id),
  );
  const candidates = parents.filter((parent) => pendingParentIds.has(parent.id));
  const matched = matchParentsToRecoveredTurn(candidates, input.terminalFacts);
  const turnId = matched[0]?.turnId ?? input.terminalFacts[0]?.turnId;
  if (matched.length === 0 || !turnId) return { outcome: 'unmatched' };

  const parentIds = new Set(matched.map((parent) => parent.id));
  const detailsByParent = collectPtcDetails(listed.messages, parentIds);
  const completedAtMs =
    input.terminalFacts.find((fact) => fact.turnId === turnId)?.completedAtMs ??
    input.processStartedAtMs;

  await persistRecoveredDisplayFacts(options.messages, {
    sessionId: input.sessionId,
    turnId,
    messages: listed.messages,
    parentIds,
    detailsByParent,
  });

  const syntheticResults = pendingRound.calls.map((call) =>
    call.name === 'run_code' && parentIds.has(call.id)
      ? recoveredRunCodeToolResult(call.id, detailsByParent.get(call.id) ?? emptyPtcDetails())
      : interruptedToolResult(call.id, call.name),
  );
  await options.history.append({
    sessionId: input.sessionId,
    turnId,
    reason: 'messageDelta',
    messages: syntheticResults.map((result) => ({ ...result, timestamp: completedAtMs })),
    operation: {
      id: `ptc-crash-recovery:${turnId}`,
      kind: 'ptc-crash-recovery',
    },
  });
  return {
    outcome: 'recovered',
    turnId,
    programs: parentIds.size,
    closedCalls: syntheticResults.length,
  };
}

function groupTerminalFacts(
  facts: readonly PtcCrashRecoveryTerminalFact[],
): ReadonlyMap<string, readonly PtcCrashRecoveryTerminalFact[]> {
  const grouped = new Map<string, PtcCrashRecoveryTerminalFact[]>();
  facts.forEach((fact) => {
    const entries = grouped.get(fact.sessionId) ?? [];
    entries.push(fact);
    grouped.set(fact.sessionId, entries);
  });
  return grouped;
}

function findPtcParents(messages: readonly DisplayMessageRecord[]): readonly PtcParent[] {
  return messages.flatMap((message) => {
    const turnId = messageTurnId(message);
    return readDisplayToolCalls(message).flatMap((call) =>
      call.tool_name === 'run_code'
        ? [{ id: call.tool_call_id, ...(turnId ? { turnId } : {}) }]
        : [],
    );
  });
}

function matchParentsToRecoveredTurn(
  parents: readonly PtcParent[],
  facts: readonly PtcCrashRecoveryTerminalFact[],
): readonly PtcParent[] {
  if (facts.length === 0) return parents;
  const recoveredTurnIds = new Set(facts.map((fact) => fact.turnId));
  return parents.filter(
    (parent) => parent.turnId !== undefined && recoveredTurnIds.has(parent.turnId),
  );
}

function collectPtcDetails(
  messages: readonly DisplayMessageRecord[],
  parentIds: ReadonlySet<string>,
): ReadonlyMap<string, PtcExecutionDetails> {
  const childrenByParent = new Map<string, Map<string, DisplayToolCall>>();
  messages.forEach((message) => {
    readDisplayToolCalls(message).forEach((call) => {
      const parentId = readNonBlankString(call.parent_tool_call_id);
      if (!parentId || !parentIds.has(parentId)) return;
      const children = childrenByParent.get(parentId) ?? new Map<string, DisplayToolCall>();
      const existing = children.get(call.tool_call_id);
      children.set(call.tool_call_id, existing ? mergeDisplayToolCall(existing, call) : call);
      childrenByParent.set(parentId, children);
    });
  });
  return new Map(
    [...parentIds].map((parentId) => {
      const children = [...(childrenByParent.get(parentId)?.values() ?? [])].map(
        toRecoveredPtcChild,
      );
      const childCalls = children.map((child) => child.record);
      const retainedFacts = children.flatMap((child) => child.retainedFacts);
      return [
        parentId,
        {
          version: 1 as const,
          child_calls: childCalls,
          retained_facts: retainedFacts,
        },
      ] as const;
    }),
  );
}

async function persistRecoveredDisplayFacts(
  messages: Pick<MessageRepository, 'upsert'>,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly messages: readonly DisplayMessageRecord[];
    readonly parentIds: ReadonlySet<string>;
    readonly detailsByParent: ReadonlyMap<string, PtcExecutionDetails>;
  },
): Promise<void> {
  for (const message of input.messages) {
    const toolCalls = readDisplayToolCalls(message);
    if (toolCalls.length === 0) continue;
    let changed = false;
    const nextToolCalls = toolCalls.map((call) => {
      if (input.parentIds.has(call.tool_call_id)) {
        if (isTerminalToolCall(call)) return call;
        changed = true;
        return recoveredRunCodeDisplayCall(
          call,
          input.detailsByParent.get(call.tool_call_id) ?? emptyPtcDetails(),
        );
      }
      const parentId = readNonBlankString(call.parent_tool_call_id);
      if (!parentId || !input.parentIds.has(parentId) || isTerminalToolCall(call)) return call;
      changed = true;
      return recoveredUnknownChildDisplayCall(call);
    });
    if (!changed) continue;
    await messages.upsert({
      sessionId: input.sessionId,
      turnId: messageTurnId(message) ?? input.turnId,
      message: { ...message, tool_calls: nextToolCalls },
    });
  }
}

function recoveredRunCodeDisplayCall(
  call: DisplayToolCall,
  details: PtcExecutionDetails,
): DisplayToolCall {
  return {
    ...call,
    tool_call_status: 3,
    tool_call_result_data: JSON.stringify(recoveredRunCodeResult(details)),
  };
}

function recoveredUnknownChildDisplayCall(call: DisplayToolCall): DisplayToolCall {
  return {
    ...call,
    tool_call_status: 3,
    outcome_unknown: true,
    tool_call_result_data: JSON.stringify({
      error: { code: OUTCOME_UNKNOWN_CODE, message: OUTCOME_UNKNOWN_MESSAGE },
      outcome_unknown: true,
    }),
  };
}

function recoveredRunCodeToolResult(parentToolCallId: string, details: PtcExecutionDetails) {
  return {
    role: 'toolResult' as const,
    toolCallId: parentToolCallId,
    toolName: 'run_code',
    content: [{ type: 'text' as const, text: outerInterruptedText(details) }],
    isError: true,
    details: { ptc: details },
  };
}

function interruptedToolResult(toolCallId: string, toolName: string) {
  return {
    role: 'toolResult' as const,
    toolCallId,
    toolName,
    content: [
      {
        type: 'text' as const,
        text: 'Tool execution was interrupted because the previous local runtime stopped. Do not retry automatically.',
      },
    ],
    isError: true,
  };
}

function recoveredRunCodeResult(details: PtcExecutionDetails) {
  const text = outerInterruptedText(details);
  return {
    tool_name: 'run_code',
    text,
    content: [{ type: 'text', text }],
    details: { ptc: details },
    isError: true,
  };
}

function outerInterruptedText(details: PtcExecutionDetails): string {
  return renderPtcExecutionEvidence(details, 'runtime-restart');
}

export function renderPtcExecutionEvidence(
  details: PtcExecutionDetails,
  reason: 'runtime-restart' | 'safety-review',
): string {
  const forced = [
    ...(details.host_forced_content ? [details.host_forced_content] : []),
    ...details.retained_facts.flatMap((fact) =>
      fact.kind === 'plugin_feedback' && fact.text ? [fact.text] : [],
    ),
  ];
  const childLines = details.child_calls.map(describeRecoveredChild);
  const childEffects = details.child_calls.flatMap(describeRecoveredChildEffects);
  const factLines = details.retained_facts.flatMap(describeRetainedFact);
  const errorCode =
    reason === 'runtime-restart' ? OUTER_INTERRUPTED_CODE : 'PTC_OUTPUT_WITHHELD_BY_SAFETY_REVIEW';
  const message =
    reason === 'runtime-restart'
      ? OUTER_INTERRUPTED_MESSAGE
      : 'PTC output was withheld after safety review. Host-recorded child execution evidence was preserved. Unknown outcomes must not be replayed automatically.';
  return truncateRecoverySummary([
    `<ptc_error code="${errorCode}">${message}</ptc_error>`,
    '<ptc_recovery>',
    'The program was not replayed. Treat unknown child outcomes as non-retryable until you verify their effects.',
    ...(childLines.length > 0 ? ['Child calls:', ...childLines] : []),
    ...(factLines.length > 0 ? ['Preserved execution facts:', ...factLines] : []),
    ...(childEffects.length > 0 ? ['Preserved child effects:', ...childEffects] : []),
    ...(forced.length > 0 ? ['Preserved plugin feedback:', ...forced] : []),
    '</ptc_recovery>',
  ]);
}

function describeRecoveredChild(call: PtcToolCallRecord): string {
  const status = {
    unknown: 'outcome unknown; do not replay automatically',
    failed: 'failed',
    completed: 'completed',
  }[call.status];
  return `- ${call.tool_name} (${call.child_tool_call_id}): ${status}`;
}

function describeRecoveredChildEffects(call: PtcToolCallRecord): readonly string[] {
  const input = call.input ? `input=${boundedJson(call.input, MAX_PTC_RECOVERY_INPUT_BYTES)}` : '';
  const resultRef = call.result_ref ? `result_ref=${call.result_ref}` : '';
  const effects = [input, resultRef].filter(Boolean);
  return effects.length > 0
    ? [`- ${call.tool_name} (${call.child_tool_call_id}): ${effects.join('; ')}`]
    : [];
}

function describeRetainedFact(fact: PtcRetainedFact): readonly string[] {
  switch (fact.kind) {
    case 'terminate_agent':
      return ['- A trusted plugin requested that the outer agent stop.'];
    case 'outcome_unknown':
      return [`- ${fact.child_tool_call_id}: outcome unknown; do not replay automatically.`];
    case 'child_error':
      return [
        `- ${fact.child_tool_call_id}: child error ${fact.code}${fact.cancelled ? ' (cancelled)' : ''}.`,
      ];
    case 'background_task':
      return [`- ${fact.child_tool_call_id}: background task ${fact.task_id} was started.`];
    case 'bash_exit':
      return [`- ${fact.child_tool_call_id}: bash exit code ${String(fact.exit_code)}.`];
    case 'approval':
      return [`- ${fact.child_tool_call_id}: approval was ${fact.status}.`];
    case 'budget_exceeded':
      return [`- PTC budget exceeded: ${fact.budget}.`];
    default:
      return describeDeliveryFact(fact);
  }
}

function describeDeliveryFact(fact: PtcRetainedFact): readonly string[] {
  switch (fact.kind) {
    case 'truncation':
      // Same rule as the live run_code result (run-code-tool.ts truncationSummary):
      // only a real cut is worth a line. "unknown" mostly means a non-builtin
      // result the host never cuts; the fact itself stays in details.
      return fact.truncated === 'true'
        ? [
            `- ${fact.child_tool_call_id}: output completeness is truncated${fact.continuation ? `; continuation=${boundedJson(fact.continuation, MAX_PTC_RECOVERY_INPUT_BYTES)}` : ''}.`,
          ]
        : [];
    case 'media_delivery':
      return [`- ${fact.child_tool_call_id}: media delivery ${fact.status}.`];
    case 'plugin_feedback':
      return fact.text
        ? [`- ${fact.child_tool_call_id}: plugin ${fact.phase} feedback was recorded.`]
        : [`- ${fact.child_tool_call_id}: plugin ${fact.phase} feedback was preserved.`];
    case 'delivery_incomplete':
      return [
        `- Outer delivery was incomplete (${fact.reason})${fact.reference ? `; reference=${fact.reference}` : ''}.`,
      ];
    default:
      return [];
  }
}

function boundedJson(value: Readonly<Record<string, unknown>>, maximumBytes: number): string {
  const json = JSON.stringify(value);
  return truncateUtf8(json, maximumBytes, '…[truncated]');
}

function truncateRecoverySummary(lines: readonly string[]): string {
  return truncateUtf8(
    lines.join('\n'),
    MAX_PTC_RECOVERY_SUMMARY_BYTES,
    '\n<ptc_recovery_summary_truncated/>',
  );
}

function truncateUtf8(value: string, maximumBytes: number, marker: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  const markerBytes = new TextEncoder().encode(marker);
  if (maximumBytes <= markerBytes.byteLength) {
    return new TextDecoder().decode(markerBytes.slice(0, maximumBytes), { stream: true });
  }
  const prefix = new TextDecoder().decode(bytes.slice(0, maximumBytes - markerBytes.byteLength), {
    stream: true,
  });
  return `${prefix}${marker}`;
}

function emptyPtcDetails(): PtcExecutionDetails {
  return { version: 1, child_calls: [], retained_facts: [] };
}

function toRecoveredPtcChild(call: DisplayToolCall): RecoveredPtcChild {
  const terminal = trustedPtcChildDetails(call);
  if (terminal) {
    const record = clonePtcToolCallRecord(terminal.record);
    const retainedFacts = terminal.retained_facts.map(clonePtcRetainedFact);
    return {
      record,
      retainedFacts:
        record.status === 'unknown' &&
        !retainedFacts.some(
          (fact) =>
            fact.kind === 'outcome_unknown' &&
            fact.child_tool_call_id === record.child_tool_call_id,
        )
          ? [
              ...retainedFacts,
              { kind: 'outcome_unknown', child_tool_call_id: record.child_tool_call_id },
            ]
          : retainedFacts,
    };
  }
  const record = fallbackPtcChildRecord(call);
  return {
    record,
    retainedFacts:
      record.status === 'unknown'
        ? [{ kind: 'outcome_unknown', child_tool_call_id: record.child_tool_call_id }]
        : [],
  };
}

function trustedPtcChildDetails(call: DisplayToolCall): PtcChildExecutionDetails | undefined {
  if (!isTerminalToolCall(call)) return undefined;
  const parentToolCallId = readNonBlankString(call.parent_tool_call_id);
  const result = parseJsonRecord(call.tool_call_result_data);
  if (!parentToolCallId || !result) return undefined;
  return readPtcChildExecutionDetails({
    tool_call_id: call.tool_call_id,
    parent_tool_call_id: parentToolCallId,
    result,
  });
}

function fallbackPtcChildRecord(call: DisplayToolCall): PtcToolCallRecord {
  const status = ptcChildStatus(call);
  return {
    child_tool_call_id: call.tool_call_id,
    parent_tool_call_id: readNonBlankString(call.parent_tool_call_id) ?? '',
    tool_name: call.tool_name,
    status,
    ...(status === 'completed' ? {} : { is_error: true }),
    ...(status === 'unknown' ? { outcome_unknown: true } : {}),
  };
}

function ptcChildStatus(call: DisplayToolCall): PtcToolCallRecord['status'] {
  if (call.tool_call_status === 2) return 'completed';
  if (call.tool_call_status === 3 && !hasOutcomeUnknown(call)) return 'failed';
  return 'unknown';
}

function hasOutcomeUnknown(call: DisplayToolCall): boolean {
  if (call.outcome_unknown === true) return true;
  const result = parseJsonRecord(call.tool_call_result_data);
  return result?.outcome_unknown === true;
}

function clonePtcToolCallRecord(record: PtcToolCallRecord): PtcToolCallRecord {
  return {
    ...record,
    ...(record.input ? { input: { ...record.input } } : {}),
  };
}

function clonePtcRetainedFact(fact: PtcRetainedFact): PtcRetainedFact {
  return {
    ...fact,
    ...(fact.kind === 'truncation' && fact.continuation
      ? { continuation: { ...fact.continuation } }
      : {}),
    ...(fact.kind === 'media_delivery' && fact.refs
      ? { refs: fact.refs.map((ref) => ({ ...ref })) }
      : {}),
  } as PtcRetainedFact;
}

function mergeDisplayToolCall(
  existing: DisplayToolCall,
  incoming: DisplayToolCall,
): DisplayToolCall {
  return isTerminalToolCall(existing) && !isTerminalToolCall(incoming)
    ? { ...incoming, ...existing }
    : { ...existing, ...incoming };
}

function isTerminalToolCall(call: DisplayToolCall): boolean {
  return call.tool_call_status === 2 || call.tool_call_status === 3;
}

function findPendingCanonicalRound(
  messages: readonly unknown[],
): PendingCanonicalRound | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const assistant = readRecord(messages[index]);
    if (assistant?.role !== 'assistant') continue;
    const calls = readCanonicalToolCalls(assistant.content);
    if (calls.length === 0) continue;
    const completed = new Set<string>();
    for (const following of messages.slice(index + 1)) {
      const result = readRecord(following);
      if (result?.role !== 'toolResult') return undefined;
      const id = readNonBlankString(result.toolCallId);
      if (id) completed.add(id);
    }
    const pending = calls.filter((call) => !completed.has(call.id));
    return pending.length > 0 ? { calls: pending } : undefined;
  }
  return undefined;
}

function readCanonicalToolCalls(value: unknown): readonly PendingCanonicalToolCall[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    const call = readRecord(candidate);
    const id = readNonBlankString(call?.id);
    const name = readNonBlankString(call?.name);
    if (call?.type !== 'toolCall' || !id || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name }];
  });
}

function readDisplayToolCalls(message: DisplayMessageRecord): readonly DisplayToolCall[] {
  return Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap((candidate) => (isDisplayToolCall(candidate) ? [candidate] : []))
    : [];
}

function isDisplayToolCall(value: unknown): value is DisplayToolCall {
  const call = readRecord(value);
  return (
    call !== undefined &&
    typeof call.tool_name === 'string' &&
    call.tool_name.length > 0 &&
    typeof call.tool_call_id === 'string' &&
    call.tool_call_id.length > 0 &&
    typeof call.tool_call_status === 'number'
  );
}

function messageTurnId(message: DisplayMessageRecord): string | undefined {
  const direct = readNonBlankString(message.turn_id) ?? readNonBlankString(message.turnId);
  if (direct) return direct;
  const meta = readRecord(message.meta);
  return readNonBlankString(meta?.turnId);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return readRecord(value);
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
