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

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_CLAIM_CHARS = 2_000;
const MAX_CHANGE_CHARS = 4_000;
const MAX_CHANGE_ITEMS = 100;
const MAX_RECENT_TAIL_CHARS = 4_000;
const MAX_RECENT_TAIL_MESSAGES = 5;
const MAX_RECENT_MESSAGE_CHARS = 800;

interface EvidenceBrief {
  readonly version: 1;
  readonly objective: { readonly text: string; readonly digest: string };
  readonly claim: string;
  readonly changes: {
    readonly files: readonly string[];
    readonly commands: readonly string[];
  };
  readonly baselineRef?: string;
  readonly recentTail: readonly { readonly role: string; readonly text: string }[];
  readonly sourceTranscriptTruncated: boolean;
}

export interface AssembleVerificationEvidenceInput {
  readonly mode: VerificationEvidenceMode;
  readonly objective: string;
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
  const brief: MutableEvidenceBrief = {
    version: 1,
    objective: {
      text: truncate(input.objective, MAX_OBJECTIVE_CHARS),
      digest: input.objectiveDigest,
    },
    claim: truncate(input.claim?.trim() || 'No explicit completion claim was supplied.', MAX_CLAIM_CHARS),
    changes,
    ...(input.baselineRef?.trim() ? { baselineRef: truncate(input.baselineRef.trim(), 128) } : {}),
    recentTail: recentTail(messages),
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
  version: 1;
  objective: { text: string; digest: string };
  claim: string;
  changes: {
    files: string[];
    commands: string[];
    ptcCalls: PtcCallEvidence[];
    truncated: boolean;
  };
  baselineRef?: string;
  recentTail: { role: string; text: string }[];
  sourceTranscriptTruncated: boolean;
}

function fitBrief(brief: MutableEvidenceBrief): string {
  let serialized = safeJsonStringify(brief);
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
    const overflow = serialized.length - MAX_VERIFICATION_BRIEF_CHARS;
    brief.objective = {
      ...brief.objective,
      text: truncate(brief.objective.text, Math.max(1, brief.objective.text.length - overflow)),
    };
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
        for (const path of filePaths(call.arguments)) files.add(path);
      }
      if (['bash', 'shell', 'exec', 'exec_command'].includes(name)) {
        const command = commandText(call.arguments);
        if (command) commands.add(command);
      }
      if (files.size + commands.size >= MAX_CHANGE_ITEMS) break;
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
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
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
    typeof value[key] === 'string' ? [truncate(value[key], 1_000)] : [],
  );
  const patch = typeof value.patch === 'string' ? value.patch : typeof value.input === 'string' ? value.input : '';
  const fromPatch = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)].map(
    (match) => truncate(match[1]?.trim() ?? '', 1_000),
  );
  return [...direct, ...fromPatch].filter(Boolean);
}

function commandText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['cmd', 'command', 'script']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return truncate(value[key].trim(), 2_000);
    }
  }
  return undefined;
}

function recentTail(messages: readonly unknown[]): { role: string; text: string }[] {
  const tail = messages.slice(-MAX_RECENT_TAIL_MESSAGES).flatMap((message) => {
    if (!isRecord(message)) return [];
    const text = messageText(message);
    return text ? [{ role: typeof message.role === 'string' ? message.role : 'unknown', text }] : [];
  });
  while (JSON.stringify(tail).length > MAX_RECENT_TAIL_CHARS && tail.length > 0) tail.shift();
  return tail;
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return truncate(content, MAX_RECENT_MESSAGE_CHARS);
  if (!Array.isArray(content)) return '';
  const text = content
    .flatMap((part) =>
      isRecord(part) && typeof part.text === 'string' && ['text', 'reasoning'].includes(String(part.type))
        ? [part.text]
        : [],
    )
    .join('\n')
    .trim();
  return truncate(text, MAX_RECENT_MESSAGE_CHARS);
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
