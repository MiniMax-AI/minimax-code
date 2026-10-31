import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {} from '@earendil-works/pi-coding-agent';

import {
  appendCompactionState,
  readCompactionCompatibility,
  type CompactionSubagentState,
  type CompactionUserQuery,
} from '../compat.js';
import {
  ContextCompactionError,
  type CheckpointEarlierFiles,
  type CheckpointGenerationMetadata,
} from '../contracts.js';
import { CHECKPOINT_SYSTEM_PROMPT, parseCheckpointHeadings } from './checkpoint-protocol.js';
import { projectTodoHistory } from './todo-cadence.js';
import { projectBackgroundHistory } from './background-cadence.js';

/** Derived from the prompt's own heading list so the protocol cannot drift. */
const CHECKPOINT_HEADINGS = parseCheckpointHeadings(CHECKPOINT_SYSTEM_PROMPT);

/**
 * Backstop for a checkpoint that drops the newest typed ask. The note only
 * states what the host can verify: questionnaire answers and automated
 * messages carry no genuine-query provenance, so the last listed query is not
 * necessarily the user's latest decision and must not override the sections
 * above. Withdrawn and superseded asks also leave Pending, so the prompt
 * records them under Key Decisions and the note checks that section before
 * reviving a query. The note sits outside the versioned appendix, whose
 * format is unchanged.
 */
const RECENT_QUERY_PRECEDENCE_NOTE =
  'Host note: `Recent user queries` below are the latest typed user messages the host could verify, copied verbatim, oldest first. Questionnaire answers and automated messages are not listed, so a later user decision may appear only in the sections above, and any such decision takes precedence over this list. Before acting, check `Completed Work`, `Current State`, `Key Decisions`, and `Pending User Asks`; treat the last query as the current request only if none of them shows it done, withdrawn, superseded, or already pending.';

export interface CheckpointGeneration extends CheckpointGenerationMetadata {
  readonly text: string;
}

export interface ValidCheckpointGeneration {
  readonly summary: string;
  readonly schemaStatus: 'exact' | 'soft_fallback';
}

export interface CheckpointMessageOptions {
  readonly timestamp: number;
  readonly subagents?: CompactionSubagentState;
  readonly earlierFiles?: CheckpointEarlierFiles;
}

export function validateCheckpointGeneration(
  generation: CheckpointGeneration,
  maxOutputTokens: number,
): ValidCheckpointGeneration {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0) {
    throw new TypeError('Checkpoint maxOutputTokens must be a non-negative safe integer.');
  }
  if (isHardInvalidGeneration(generation, maxOutputTokens)) {
    throw invalidCheckpoint('Checkpoint LLM returned a non-terminal or oversized response.');
  }
  const summary = generation.text.trim();
  if (!summary) throw invalidCheckpoint('Checkpoint LLM returned an empty response.');
  return {
    summary,
    schemaStatus: hasExactCheckpointSections(summary) ? 'exact' : 'soft_fallback',
  };
}

function isHardInvalidGeneration(
  generation: CheckpointGeneration,
  maxOutputTokens: number,
): boolean {
  return (
    (generation.stopReason !== 'stop' && generation.stopReason !== 'length') ||
    generation.responseContentKinds.some((kind) => kind === 'toolCall' || kind === 'unknown') ||
    !Number.isSafeInteger(generation.outputTokens) ||
    generation.outputTokens < 0 ||
    generation.outputTokens > maxOutputTokens ||
    typeof generation.text !== 'string'
  );
}

function hasExactCheckpointSections(summary: string): boolean {
  const firstHeading = `## ${CHECKPOINT_HEADINGS[0]}`;
  if (!summary.startsWith(`${firstHeading}\n`) && !summary.startsWith(`${firstHeading}\r\n`)) {
    return false;
  }
  const matches = [...summary.matchAll(/^## ([^\r\n]+)\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/gmu)];
  if (matches.length !== CHECKPOINT_HEADINGS.length) return false;
  return CHECKPOINT_HEADINGS.every((heading, index) => {
    const match = matches[index];
    return match?.[1] === heading && Boolean(match[2]?.trim());
  });
}

export function buildCheckpointMessage(
  h0: readonly AgentMessage[],
  summary: string,
  tokensBefore: number,
  options: CheckpointMessageOptions,
): AgentMessage {
  if (!Number.isSafeInteger(tokensBefore) || tokensBefore < 0) {
    throw new TypeError('Checkpoint tokensBefore must be a non-negative safe integer.');
  }
  if (!Number.isFinite(options.timestamp)) {
    throw new TypeError('Checkpoint timestamp must be finite.');
  }
  const previous = readCompactionCompatibility(h0[0]);
  const state = buildVerifiedCheckpointState(
    h0,
    previous?.recentUserQueries ?? [],
    options.subagents,
  );
  const body = [
    summary,
    ...(options.earlierFiles ? [earlierFilesText(options.earlierFiles)] : []),
    ...(state.recentUserQueries.length > 0 ? [RECENT_QUERY_PRECEDENCE_NOTE] : []),
  ].join('\n\n');
  const checkpoint: AgentMessage = {
    role: 'compactionSummary',
    summary: appendCompactionState(body, state),
    tokensBefore,
    timestamp: options.timestamp,
  };
  return checkpoint;
}

function earlierFilesText(files: CheckpointEarlierFiles): string {
  return [
    'Files from before this compaction:',
    `- Full conversation history before each compaction, one JSONL file per compaction (the highest g<generation> is the latest): ${files.snapshots}`,
    `- Tool images and oversized tool outputs: ${files.toolOutputs}`,
    'Read them when you need exact details that the summary above leaves out.',
  ].join('\n');
}

function buildVerifiedCheckpointState(
  h0: readonly AgentMessage[],
  inheritedQueries: readonly CompactionUserQuery[],
  subagents: CompactionSubagentState | undefined,
) {
  const todo = projectTodoHistory(h0);
  const background = projectBackgroundHistory(h0);
  return {
    recentUserQueries: collectRecentUserQueries(h0, inheritedQueries),
    ...(todo.todoState === undefined ? {} : { todoState: todo.todoState }),
    ...(todo.todoCadence === undefined ? {} : { todoCadence: todo.todoCadence }),
    ...(background.hasBackgroundState
      ? {
          backgroundCadence: {
            assistantIterationsSinceReminder: background.assistantIterationsSinceReminder,
            ...(background.observedTerminalCount === undefined
              ? {}
              : { observedTerminalCount: background.observedTerminalCount }),
          },
        }
      : {}),
    ...(subagents === undefined ? {} : { subagents }),
  };
}

function collectRecentUserQueries(
  messages: readonly AgentMessage[],
  inherited: readonly CompactionUserQuery[],
): CompactionUserQuery[] {
  const collected = [...inherited];
  messages.forEach((message) => {
    if (message.role !== 'user' || Reflect.get(message, 'archonCompaction')) return;
    const text = readGenuineUserQueryText(message);
    if (!text?.trim() || /^\/compact(?:\s|$)/iu.test(text.trim())) return;
    const timestampMs = readFiniteNumber(message, 'timestamp');
    collected.push({ text, ...(timestampMs === undefined ? {} : { timestampMs }) });
  });
  return collected.slice(-2);
}

export function readGenuineUserQueryText(message: AgentMessage): string | undefined {
  if (Object.hasOwn(message, 'genuineUserQueryText')) {
    const text = Reflect.get(message, 'genuineUserQueryText');
    return typeof text === 'string' ? text : undefined;
  }
  if (!Object.hasOwn(message, 'canonicalTextRange')) return undefined;
  return readCanonicalRangeText(message);
}

function readCanonicalRangeText(message: AgentMessage): string | undefined {
  const content = readSingleText(message);
  const range = Reflect.get(message, 'canonicalTextRange');
  if (!content || !range || typeof range !== 'object') return undefined;
  const startOffset = Reflect.get(range, 'startOffset');
  const endOffset = Reflect.get(range, 'endOffset');
  if (
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset < startOffset ||
    endOffset > content.length
  ) {
    return undefined;
  }
  return content.slice(startOffset, endOffset);
}

function readSingleText(message: AgentMessage): string | undefined {
  const content = Reflect.get(message, 'content');
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) =>
    block && typeof block === 'object' && Reflect.get(block, 'type') === 'text'
      ? [Reflect.get(block, 'text')]
      : [],
  );
  return texts.length === 1 && typeof texts[0] === 'string' ? texts[0] : undefined;
}

function readFiniteNumber(value: object, key: string): number | undefined {
  const field = Reflect.get(value, key);
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function invalidCheckpoint(message: string): ContextCompactionError {
  return new ContextCompactionError('INVALID_CHECKPOINT', 'llm_checkpoint', message);
}
