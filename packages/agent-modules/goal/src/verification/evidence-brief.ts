import type {
  TranscriptWindow,
  VerificationEvidence,
  VerificationEvidenceMode,
} from './verifier-port.js';
import { isInternalContextMessage } from '../internal-context-fragment.js';
import { readPtcExecutionDetails, type PtcExecutionDetails } from '@mavis/agent-core/tools';

export const MAX_VERIFICATION_BRIEF_CHARS = 14_000;
export const MAX_SUBAGENT_VERIFICATION_PROMPT_CHARS = 16_000;
export const MAX_EVALUATOR_TAIL_CHARS = 32_000;
export const MAX_EVALUATOR_TAIL_MESSAGES = 20;
export const MAX_TRANSCRIPT_FALLBACK_CHARS = 512_000;
export const MAX_TRANSCRIPT_FALLBACK_MESSAGES = 200;

const MAX_CLAIM_CHARS = 2_000;
const MAX_CHANGE_CHARS = 4_000;
const MAX_CHANGE_ITEMS = 100;
const MAX_RECENT_TAIL_CHARS = 4_000;
const MAX_RECENT_TAIL_MESSAGES = 5;
const MAX_RECENT_MESSAGE_CHARS = 800;
const MAX_PARENT_INPUT_CHARS = 4_000;
const MAX_TOOL_INDEX_CHARS = 4_000;
const MAX_ATTACHMENT_INDEX_CHARS = 700;

interface BoundedIndex<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

interface IndexedInput {
  sequence: number;
  text: string;
  textTruncated: boolean;
  questionnaireRequestId?: string;
}

interface IndexedToolEvent {
  /** Fixed by the host's worker-session capture, never taken from message content. */
  readonly actor: 'worker';
  readonly provenance: 'worker_session';
  sequence: number;
  part: number;
  kind: 'call' | 'result';
  toolCallId?: string;
  name: string;
  paths?: readonly string[];
  status?: 'error' | 'success' | 'unknown';
  questionnaireRequestId?: string;
  waitingForUser?: boolean;
  metadataTruncated?: boolean;
}

interface IndexedAttachment {
  sequence: number;
  part: number;
  type: string;
  name?: string;
  mimeType?: string;
  metadataTruncated?: boolean;
}

export interface AssembleVerificationEvidenceInput {
  readonly mode: VerificationEvidenceMode;
  readonly objectiveDigest: string;
  readonly claim?: string;
  readonly baselineRef?: string;
  readonly transcriptWindow: TranscriptWindow;
}

/**
 * Build one bounded evidence index. Verifier prompts render these exact strings;
 * no pretty-printing or second measurement path can expand them afterwards.
 */
export function assembleVerificationEvidence(
  input: AssembleVerificationEvidenceInput,
): VerificationEvidence {
  const messages = input.transcriptWindow.messages;
  const changes = extractChanges(messages);
  const indexes = evidenceIndexes(messages);
  const brief: MutableEvidenceBrief = {
    version: 2,
    objective: { digest: input.objectiveDigest },
    claim: truncate(
      input.claim?.trim() || 'No explicit completion claim was supplied.',
      MAX_CLAIM_CHARS,
    ),
    changes,
    ...(input.baselineRef?.trim() ? { baselineRef: truncate(input.baselineRef.trim(), 128) } : {}),
    recentTail: recentTail(messages),
    ...indexes,
    coverage: {
      sourceMessageCount: messages.length,
      briefTruncated:
        (input.claim?.length ?? 0) > MAX_CLAIM_CHARS ||
        (input.baselineRef?.trim().length ?? 0) > 128 ||
        changes.truncated ||
        messages.length > MAX_RECENT_TAIL_MESSAGES ||
        messages.some(
          (message) =>
            isRecord(message) &&
            ['user', 'assistant'].includes(String(message.role)) &&
            plainText(message).length > MAX_RECENT_MESSAGE_CHARS,
        ) ||
        indexes.parentInputs.truncated ||
        indexes.toolEvents.truncated ||
        indexes.attachments.truncated,
      omittedContent:
        'Tool argument bodies, result bodies, attachment bytes/references, and reasoning are omitted. This index is not a complete transcript or visual proof.',
    },
    sourceTranscriptTruncated: input.transcriptWindow.truncated,
  };
  const serializedBrief = fitBrief(brief);
  const evaluatorTail = serializeBoundedMessages(
    messages,
    MAX_EVALUATOR_TAIL_MESSAGES,
    MAX_EVALUATOR_TAIL_CHARS,
  );
  const transcript = serializeBoundedMessages(
    messages,
    MAX_TRANSCRIPT_FALLBACK_MESSAGES,
    MAX_TRANSCRIPT_FALLBACK_CHARS,
  );
  return {
    mode: input.mode,
    serializedBrief,
    briefChars: serializedBrief.length,
    serializedEvaluatorTail: evaluatorTail.serialized,
    evaluatorTailTruncated: input.transcriptWindow.truncated || evaluatorTail.truncated,
    serializedTranscript: transcript.serialized,
    transcriptTruncated: input.transcriptWindow.truncated || transcript.truncated,
  };
}

interface MutableEvidenceBrief {
  version: 2;
  /**
   * Only the digest: every verifier renders the full objective once, outside
   * the brief, so the brief budget stays with the evidence.
   */
  objective: { digest: string };
  claim: string;
  changes: {
    files: string[];
    commands: string[];
    ptcCalls: PtcCallEvidence[];
    truncated: boolean;
  };
  baselineRef?: string;
  recentTail: { role: string; text: string }[];
  parentInputs: BoundedIndex<IndexedInput>;
  toolEvents: BoundedIndex<IndexedToolEvent>;
  attachments: BoundedIndex<IndexedAttachment>;
  coverage: { sourceMessageCount: number; briefTruncated: boolean; omittedContent: string };
  sourceTranscriptTruncated: boolean;
}

function fitBrief(brief: MutableEvidenceBrief): string {
  let serialized = safeJsonStringify(brief);
  if (serialized.length > MAX_VERIFICATION_BRIEF_CHARS) brief.coverage.briefTruncated = true;
  while (serialized.length > MAX_VERIFICATION_BRIEF_CHARS && brief.recentTail.length > 0) {
    brief.recentTail.shift();
    serialized = safeJsonStringify(brief);
  }
  while (
    serialized.length > MAX_VERIFICATION_BRIEF_CHARS &&
    (brief.changes.commands.length > 0 || brief.changes.files.length > 0)
  ) {
    if (brief.changes.commands.length >= brief.changes.files.length) {
      brief.changes.commands.pop();
    } else {
      brief.changes.files.pop();
    }
    brief.changes.truncated = true;
    serialized = safeJsonStringify(brief);
  }
  if (serialized.length > MAX_VERIFICATION_BRIEF_CHARS && 'baselineRef' in brief) {
    delete brief.baselineRef;
    serialized = safeJsonStringify(brief);
  }
  if (serialized.length > MAX_VERIFICATION_BRIEF_CHARS) {
    const overflow = serialized.length - MAX_VERIFICATION_BRIEF_CHARS;
    brief.claim = truncate(brief.claim, Math.max(1, brief.claim.length - overflow));
    serialized = safeJsonStringify(brief);
  }
  if (serialized.length > MAX_VERIFICATION_BRIEF_CHARS) {
    throw new Error('Goal verification evidence brief exceeded its hard rendered limit.');
  }
  return serialized;
}

/** Keep untrusted data from manufacturing the XML-like prompt boundary itself. */
function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function extractChanges(messages: readonly unknown[]): {
  files: string[];
  commands: string[];
  ptcCalls: PtcCallEvidence[];
  truncated: boolean;
} {
  const files = new Set<string>();
  const commands = new Set<string>();
  const ptcCalls: PtcCallEvidence[] = [];
  const seenPtcChildIds = new Set<string>();
  let truncated = false;
  const itemCount = (): number => files.size + commands.size + ptcCalls.length;
  const add = (target: Set<string>, value: string, maxChars: number): void => {
    const bounded = truncate(value, maxChars);
    if (bounded !== value) truncated = true;
    if (target.has(bounded)) return;
    if (itemCount() >= MAX_CHANGE_ITEMS) {
      truncated = true;
      return;
    }
    target.add(bounded);
  };
  for (const message of messages) {
    for (const call of toolCalls(message)) {
      const name = call.name.toLowerCase();
      if (['write', 'edit', 'apply_patch'].includes(name)) {
        for (const path of filePaths(call.arguments)) add(files, path, 1_000);
      }
      if (['bash', 'shell', 'exec', 'exec_command'].includes(name)) {
        const command = commandText(call.arguments);
        if (command) add(commands, command, 2_000);
      }
    }
    const ptc = readPtcExecutionDetails(message);
    for (const call of ptc?.child_calls ?? []) {
      if (seenPtcChildIds.has(call.child_tool_call_id)) continue;
      seenPtcChildIds.add(call.child_tool_call_id);
      if (itemCount() >= MAX_CHANGE_ITEMS) {
        truncated = true;
        break;
      }
      const evidence = ptcCallEvidence(ptc, call);
      ptcCalls.push(evidence);
      if (call.status !== 'completed') continue;
      const name = call.tool_name.toLowerCase();
      if (['write', 'edit', 'apply_patch'].includes(name)) {
        for (const path of evidence.files ?? []) add(files, path, 1_000);
      }
      if (['bash', 'shell', 'exec', 'exec_command'].includes(name) && evidence.command) {
        add(commands, evidence.command, 2_000);
      }
    }
  }
  return capChanges([...files], [...commands], ptcCalls, truncated);
}

interface PtcCallEvidence {
  readonly childToolCallId: string;
  readonly toolName: string;
  readonly status: 'completed' | 'failed' | 'unknown';
  readonly files?: readonly string[];
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly isError?: boolean;
  readonly outcomeUnknown?: boolean;
  /** Paths/commands are summaries with known credential patterns masked. */
  readonly inputRedacted?: boolean;
}

function ptcCallEvidence(
  ptc: PtcExecutionDetails | undefined,
  call: PtcExecutionDetails['child_calls'][number],
): PtcCallEvidence {
  const paths = filePaths(call.input);
  const command = commandText(call.input);
  const exitCode = ptc ? ptcBashExitCode(ptc, call.child_tool_call_id) : undefined;
  return {
    childToolCallId: call.child_tool_call_id,
    toolName: call.tool_name,
    status: call.status,
    ...(paths.length > 0 ? { files: paths } : {}),
    ...(command ? { command } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(call.is_error === undefined ? {} : { isError: call.is_error }),
    ...(call.outcome_unknown === undefined ? {} : { outcomeUnknown: call.outcome_unknown }),
    ...(Array.isArray(call.input?.redacted_fields) && call.input.redacted_fields.length > 0
      ? { inputRedacted: true }
      : {}),
  };
}

function ptcBashExitCode(
  details: PtcExecutionDetails,
  childToolCallId: string,
): number | null | undefined {
  const fact = details.retained_facts.find(
    (candidate) =>
      candidate.kind === 'bash_exit' && candidate.child_tool_call_id === childToolCallId,
  );
  return fact?.kind === 'bash_exit' ? fact.exit_code : undefined;
}

function capChanges(
  files: string[],
  commands: string[],
  ptcCalls: PtcCallEvidence[],
  initiallyTruncated: boolean,
): { files: string[]; commands: string[]; ptcCalls: PtcCallEvidence[]; truncated: boolean } {
  let truncated = initiallyTruncated;
  let serialized = safeJsonStringify({ files, commands, ptcCalls, truncated });
  while (
    serialized.length > MAX_CHANGE_CHARS &&
    (commands.length > 0 || files.length > 0 || ptcCalls.length > 0)
  ) {
    if (commands.length >= files.length && commands.length >= ptcCalls.length) commands.pop();
    else if (files.length >= ptcCalls.length) files.pop();
    else ptcCalls.pop();
    truncated = true;
    serialized = safeJsonStringify({ files, commands, ptcCalls, truncated });
  }
  return { files, commands, ptcCalls, truncated };
}

function toolCalls(message: unknown): readonly { name: string; arguments: unknown }[] {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((part) => {
    if (!isRecord(part)) return [];
    const name =
      typeof part.name === 'string'
        ? part.name
        : typeof part.toolName === 'string'
          ? part.toolName
          : undefined;
    if (!name || !['toolCall', 'tool-call', 'tool_call'].includes(String(part.type))) return [];
    return [{ name, arguments: part.arguments ?? part.args ?? {} }];
  });
}

function filePaths(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const direct = ['path', 'filePath', 'file_path'].flatMap((key) =>
    typeof value[key] === 'string' ? [value[key]] : [],
  );
  const patch =
    typeof value.patch === 'string'
      ? value.patch
      : typeof value.input === 'string'
        ? value.input
        : '';
  const fromPatch = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)].map(
    (match) => match[1]?.trim() ?? '',
  );
  return [...direct, ...fromPatch].filter(Boolean);
}

function commandText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['cmd', 'command', 'script']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return value[key].trim();
    }
  }
  return undefined;
}

function recentTail(messages: readonly unknown[]): { role: string; text: string }[] {
  const tail = messages.slice(-MAX_RECENT_TAIL_MESSAGES).flatMap((message) => {
    if (!isRecord(message) || !['assistant', 'user'].includes(String(message.role))) return [];
    const text = messageText(message);
    return text
      ? [{ role: typeof message.role === 'string' ? message.role : 'unknown', text }]
      : [];
  });
  while (JSON.stringify(tail).length > MAX_RECENT_TAIL_CHARS && tail.length > 0) tail.shift();
  return tail;
}

function messageText(message: Record<string, unknown>): string {
  return truncate(plainText(message), MAX_RECENT_MESSAGE_CHARS);
}

/** Select metadata, never arbitrary tool arguments, output, or attachment payloads. */
function evidenceIndexes(messages: readonly unknown[]): {
  parentInputs: BoundedIndex<IndexedInput>;
  toolEvents: BoundedIndex<IndexedToolEvent>;
  attachments: BoundedIndex<IndexedAttachment>;
} {
  const inputs: IndexedInput[] = [];
  const events: IndexedToolEvent[] = [];
  const attachments: IndexedAttachment[] = [];
  for (const [index, value] of messages.entries()) {
    if (!isRecord(value)) continue;
    const sequence = index + 1;
    if (
      value.role === 'user' &&
      !isInternalContextMessage(value as unknown as Parameters<typeof isInternalContextMessage>[0])
    ) {
      const raw = plainText(value);
      if (raw) {
        const requestId = raw.match(
          /<questionnaire-response>\s*<requestId>([^<]+)<\/requestId>/u,
        )?.[1];
        const text = boundedText(raw, 1_200);
        inputs.push({
          sequence,
          text,
          textTruncated: text !== raw,
          ...(requestId ? { questionnaireRequestId: truncate(requestId, 128) } : {}),
        });
      }
    }
    if (value.role === 'toolResult') {
      const details = isRecord(value.details) ? value.details : {};
      events.push({
        actor: 'worker',
        provenance: 'worker_session',
        sequence,
        part: 0,
        kind: 'result',
        ...toolIdentity(value),
        status: value.isError === true ? 'error' : value.isError === false ? 'success' : 'unknown',
        ...(typeof details.request_id === 'string'
          ? { questionnaireRequestId: truncate(details.request_id, 128) }
          : {}),
        ...(typeof details.waiting_for_user === 'boolean'
          ? { waitingForUser: details.waiting_for_user }
          : {}),
      });
    }
    if (!Array.isArray(value.content)) continue;
    for (const [partIndex, part] of value.content.entries()) {
      if (!isRecord(part)) continue;
      if (
        value.role === 'assistant' &&
        ['toolCall', 'tool-call', 'tool_call'].includes(String(part.type))
      ) {
        const paths = filePaths(part.arguments ?? part.args);
        events.push({
          actor: 'worker',
          provenance: 'worker_session',
          sequence,
          part: partIndex,
          kind: 'call',
          ...toolIdentity(part),
          ...(paths.length ? { paths: paths.slice(0, 4).map((path) => truncate(path, 300)) } : {}),
          ...(paths.length > 4 || paths.some((path) => path.length > 300)
            ? { metadataTruncated: true }
            : {}),
        });
      }
      if (
        ['image', 'image_url', 'file', 'document', 'audio', 'video'].includes(String(part.type))
      ) {
        attachments.push({
          sequence,
          part: partIndex,
          type: String(part.type),
          ...(typeof part.name === 'string' ? { name: truncate(part.name, 100) } : {}),
          ...(typeof part.mimeType === 'string' ? { mimeType: truncate(part.mimeType, 80) } : {}),
          ...((typeof part.name === 'string' && part.name.length > 100) ||
          (typeof part.mimeType === 'string' && part.mimeType.length > 80)
            ? { metadataTruncated: true }
            : {}),
        });
      }
    }
  }
  return {
    parentInputs: boundIndex(
      inputs,
      MAX_PARENT_INPUT_CHARS,
      inputs.some((item) => item.textTruncated),
    ),
    toolEvents: boundIndex(
      events,
      MAX_TOOL_INDEX_CHARS,
      events.some((item) => item.metadataTruncated === true),
    ),
    attachments: boundIndex(
      attachments,
      MAX_ATTACHMENT_INDEX_CHARS,
      attachments.some((item) => item.metadataTruncated === true),
    ),
  };
}

function plainText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n')
    .trim();
}

function toolIdentity(value: Record<string, unknown>): {
  name: string;
  toolCallId?: string;
  metadataTruncated?: boolean;
} {
  const name = value.name ?? value.toolName;
  const id = value.toolCallId ?? value.id ?? value.tool_call_id;
  return {
    name: typeof name === 'string' ? truncate(name, 100) : 'unknown',
    ...(typeof id === 'string' ? { toolCallId: truncate(id, 128) } : {}),
    ...((typeof name === 'string' && name.length > 100) ||
    (typeof id === 'string' && id.length > 128)
      ? { metadataTruncated: true }
      : {}),
  };
}

function boundedText(text: string, maxChars: number): string {
  let result = truncate(text, maxChars);
  while (safeJsonStringify(result).length > maxChars) {
    result = truncate(result, Math.max(1, result.length - Math.ceil(result.length / 4)));
  }
  return result;
}

/** Keep the earliest scope and latest evidence rather than dropping the first clarification. */
function boundIndex<T>(items: T[], maxChars: number, truncated = false): BoundedIndex<T> {
  const result = { items: items.slice(), total: items.length, truncated };
  while (safeJsonStringify(result).length > maxChars && result.items.length > 0) {
    result.items.splice(Math.floor(result.items.length / 2), 1);
    result.truncated = true;
  }
  return result;
}

function serializeBoundedMessages(
  messages: readonly unknown[],
  maxMessages: number,
  maxChars: number,
): { readonly serialized: string; readonly truncated: boolean } {
  const candidates = messages.slice(-maxMessages);
  let retained = candidates.slice();
  let serialized = JSON.stringify(retained);
  let contentTruncated = candidates.length < messages.length;
  while (serialized.length > maxChars && retained.length > 1) {
    retained.shift();
    contentTruncated = true;
    serialized = JSON.stringify(retained);
  }
  if (serialized.length > maxChars) {
    const preview = truncate(serialized, Math.max(1, maxChars - 96));
    retained = [{ truncatedMessagePreview: preview }];
    contentTruncated = true;
    serialized = JSON.stringify(retained);
  }
  if (serialized.length > maxChars) serialized = '[]';
  return {
    serialized,
    truncated: contentTruncated || serialized === '[]',
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return '…'.slice(0, maxChars);
  return `${value.slice(0, maxChars - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
