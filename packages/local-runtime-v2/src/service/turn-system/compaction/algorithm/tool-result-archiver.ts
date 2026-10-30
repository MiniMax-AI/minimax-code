import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  listRequestImages,
  replaceRequestImages,
  type PiTurnRunnerLogger,
  type RequestImage,
} from '@mavis/agent-core/pi-turn-runner';
import { archivedImageText } from '@mavis/context-manager';

import type { ToolResultCompactionConfig } from '../contracts.js';
import { parseToolRounds, type ToolCallIdentity, type ToolRound } from './history-reduction.js';

// Defensive defaults for standalone algorithm callers. Production always injects
// the config.yaml/Apollo-resolved settings from production-composition.
const TOOL_RESULT_ARCHIVE_ENABLED = true;
const TOOL_RESULT_ARCHIVE_WATERMARK_BYTES = 256 * 1_024;
const TOOL_RESULT_ARCHIVE_MIN_SAVINGS_BYTES = 256 * 1_024;
const TOOL_RESULT_ARCHIVE_MIN_CANDIDATE_BYTES = 2 * 1_024;
const TOOL_RESULT_ARCHIVE_KEEP_RECENT_ROUNDS = 5;
const TOOL_RESULT_ARCHIVE_RECEIPT_ESTIMATE_BYTES = 512;
const TOOL_RESULT_ARCHIVE_RECEIPT_TOOL_NAME_MAX_BYTES = 64;
const TOOL_RESULT_ARCHIVE_RECEIPT_SOURCE_MAX_BYTES = 256;
const CHUNKED_JSONL_READ_FORMAT = 'chunked_jsonl_v1';
const TOOL_RESULT_TRIM_RECEIPT =
  '[Earlier tool output removed by context compaction; original content unavailable.]';

const DEFAULT_REFERENCE_MEMO_ENTRIES = 512;
const CONTROL_TOOL_NAMES = new Set([
  'skill',
  'ask_user',
  'request_feature_enable',
  'todowrite',
  'create_goal',
  'update_goal',
  'get_goal',
  'enterplanmode',
  'exitplanmode',
]);

type ToolResultMessage = Extract<AgentMessage, { readonly role: 'toolResult' }>;

interface ToolResultArtifactInput {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly text: string;
  readonly originalBytes: number;
  readonly sensitive: boolean;
}

interface ToolResultArtifact {
  readonly reference: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface ToolResultImageArtifactInput {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly data: string;
  readonly mimeType: string;
}

export interface ToolResultArchiverOptions {
  readonly writeArtifact: (
    input: ToolResultArtifactInput,
  ) => ToolResultArtifact | Promise<ToolResultArtifact>;
  /** Stores an archived image that names no source file; without it the receipt names none. */
  readonly writeImageArtifact?: (
    input: ToolResultImageArtifactInput,
  ) => { readonly reference: string } | Promise<{ readonly reference: string }>;
  readonly logger?: Pick<PiTurnRunnerLogger, 'info' | 'error'>;
  readonly referenceMemoEntries?: number;
  /** Live threshold source. Missing or invalid fields retain the current defaults. */
  readonly getConfig?: (() => ToolResultCompactionConfig | undefined) | undefined;
}

export interface ToolResultArchivePlanCandidate {
  readonly key: string;
  readonly index: number;
  readonly message: ToolResultMessage;
  readonly call: ToolCallIdentity;
  readonly visibleTextBytes: number;
  readonly snapshotBytes: number;
  readonly existingReference?: string;
  readonly existingReadFormat?: string;
}

interface ToolResultArchiveReplacement {
  readonly key: string;
  readonly index: number;
  readonly message: ToolResultMessage;
  readonly receiptBytes: number;
  readonly artifactCreated: boolean;
}

interface ResolvedToolResultCompactionConfig {
  readonly enabled: boolean;
  readonly watermarkBytes: number;
  readonly minSavingsBytes: number;
  readonly minCandidateBytes: number;
  readonly keepRecentRounds: number;
}

export interface ToolResultArchivePlan {
  readonly messages: readonly AgentMessage[];
  readonly candidates: readonly ToolResultArchivePlanCandidate[];
  readonly totalTextBytes: number;
  readonly estimatedSavingsBytes: number;
  readonly minSavingsBytes: number;
}

export interface ToolResultArchiveCandidate {
  readonly messages: readonly AgentMessage[];
  readonly archivedResultCount: number;
  readonly actualSavingsBytes: number;
}

export interface ToolResultTrimCandidate {
  readonly messages: readonly AgentMessage[];
  readonly trimmedResultCount: number;
  readonly actualSavingsBytes: number;
}

export type ToolResultCompactionCandidate = ToolResultArchiveCandidate | ToolResultTrimCandidate;

export interface ToolResultImageArchive {
  readonly messages: readonly AgentMessage[];
  readonly archivedImageCount: number;
  readonly savedBytes: number;
}

/**
 * Plans the shared ToolResult candidate set for durable context compaction.
 * Materialization either writes recoverable archive receipts or, when the
 * model has no read tool, applies destructive receipts without artifact I/O.
 * Planning itself is side-effect free.
 */
export class ToolResultArchiver {
  private readonly references = new Map<string, ToolResultArtifact>();
  private readonly referenceMemoEntries: number;

  constructor(private readonly options: ToolResultArchiverOptions) {
    this.referenceMemoEntries = positiveInteger(
      options.referenceMemoEntries ?? DEFAULT_REFERENCE_MEMO_ENTRIES,
      'referenceMemoEntries',
    );
  }

  plan(input: {
    readonly sessionId: string;
    readonly messages: readonly AgentMessage[];
  }): ToolResultArchivePlan | undefined {
    try {
      const config = resolveToolResultCompactionConfig(
        readToolResultCompactionConfig(this.options.getConfig),
      );
      if (!config.enabled) return undefined;
      const totalTextBytes = countToolResultTextBytes(input.messages);
      if (totalTextBytes <= config.watermarkBytes) return undefined;
      const candidates = selectCandidates(
        input.messages,
        config.minCandidateBytes,
        config.keepRecentRounds,
      );
      const estimatedSavingsBytes = estimateSavings(candidates);
      if (estimatedSavingsBytes <= config.minSavingsBytes) {
        this.logSummary(input, {
          outcome: 'below_minimum_savings',
          totalTextBytes,
          effectiveTextBytes: totalTextBytes,
          candidateCount: candidates.length,
          estimatedSavings: estimatedSavingsBytes,
          actualSavings: 0,
          artifactCount: 0,
        });
        return undefined;
      }
      return {
        messages: input.messages,
        candidates,
        totalTextBytes,
        estimatedSavingsBytes,
        minSavingsBytes: config.minSavingsBytes,
      };
    } catch (error) {
      logBestEffort(this.options.logger, 'error', {
        event: 'tool_result_compaction_plan_failed',
        session_id: input.sessionId,
        reason: safeErrorReason(error),
      });
      return undefined;
    }
  }

  async materialize(input: {
    readonly sessionId: string;
    readonly plan: ToolResultArchivePlan;
  }): Promise<ToolResultArchiveCandidate | undefined> {
    const replacements = await this.buildReplacements(input, input.plan.candidates);
    const materialized = this.finishMaterialization(input, replacements);
    if (!materialized) return undefined;
    return {
      messages: materialized.messages,
      archivedResultCount: replacements.length,
      actualSavingsBytes: materialized.actualSavingsBytes,
    };
  }

  /**
   * Applies the same planned candidate set destructively when no read tool is
   * available. This path performs no artifact I/O and never advertises a
   * recovery path that the model cannot use.
   */
  async materializeTrim(input: {
    readonly sessionId: string;
    readonly plan: ToolResultArchivePlan;
  }): Promise<ToolResultTrimCandidate | undefined> {
    const replacements = input.plan.candidates.map(buildTrimReplacement);
    const materialized = this.finishMaterialization(input, replacements);
    if (!materialized) return undefined;
    return {
      messages: materialized.messages,
      trimmedResultCount: replacements.length,
      actualSavingsBytes: materialized.actualSavingsBytes,
    };
  }

  /**
   * Replaces every image in history, user attachments and tool results alike,
   * with a receipt naming its file, so later requests carry text instead. An
   * image whose history names no source file is written to the Session
   * artifacts first. Video blocks stay: they have their own projection.
   */
  async archiveImages(input: {
    readonly sessionId: string;
    readonly messages: readonly AgentMessage[];
  }): Promise<ToolResultImageArchive | undefined> {
    const images = listRequestImages(input.messages).filter(
      (image) => !image.mimeType?.toLowerCase().startsWith('video/'),
    );
    if (images.length === 0) return undefined;
    const receipts = new Map<string, string>();
    let savedBytes = 0;
    for (const image of images) {
      const receipt = archivedImageText(image.path ?? (await this.writeImageFile(input, image)));
      receipts.set(image.key, receipt);
      savedBytes += Math.max(0, image.base64Bytes - Buffer.byteLength(receipt));
    }
    logBestEffort(this.options.logger, 'info', {
      event: 'context_image_archive',
      session_id: input.sessionId,
      archived_image_count: images.length,
      saved_bytes: savedBytes,
    });
    return {
      messages: replaceRequestImages(input.messages, (image) => receipts.get(image.key)),
      archivedImageCount: images.length,
      savedBytes,
    };
  }

  /**
   * Writes an image of a tool result or user message to the Session artifacts;
   * `undefined` when it cannot. A user image is keyed by its message position,
   * as user messages have no call id.
   */
  async writeImageFile(
    input: { readonly sessionId: string; readonly messages: readonly AgentMessage[] },
    image: RequestImage,
  ): Promise<string | undefined> {
    const message = input.messages[image.messageIndex];
    if (!this.options.writeImageArtifact) return undefined;
    if (message?.role !== 'toolResult' && message?.role !== 'user') return undefined;
    const block = Array.isArray(message.content) ? message.content[image.blockIndex] : undefined;
    if (block?.type !== 'image') return undefined;
    const owner =
      message.role === 'toolResult'
        ? { toolCallId: message.toolCallId, toolName: message.toolName }
        : { toolCallId: `user-${image.messageIndex}`, toolName: 'user' };
    try {
      const artifact = await this.options.writeImageArtifact({
        sessionId: input.sessionId,
        ...owner,
        data: block.data,
        mimeType: block.mimeType,
      });
      return nonEmptyString(artifact.reference);
    } catch (error) {
      logBestEffort(this.options.logger, 'error', {
        event: 'context_image_artifact_failed',
        session_id: input.sessionId,
        tool_name: owner.toolName,
        reason: safeErrorReason(error),
      });
      return undefined;
    }
  }

  private finishMaterialization(
    input: { readonly sessionId: string; readonly plan: ToolResultArchivePlan },
    replacements: readonly ToolResultArchiveReplacement[],
  ):
    | { readonly messages: readonly AgentMessage[]; readonly actualSavingsBytes: number }
    | undefined {
    const actualSavingsBytes = calculateActualSavings(input.plan.candidates, replacements);
    const artifactCount = replacements.filter(({ artifactCreated }) => artifactCreated).length;
    if (actualSavingsBytes <= input.plan.minSavingsBytes) {
      this.logSummary(input, {
        outcome: 'below_minimum_actual_savings',
        totalTextBytes: input.plan.totalTextBytes,
        effectiveTextBytes: input.plan.totalTextBytes,
        candidateCount: input.plan.candidates.length,
        estimatedSavings: input.plan.estimatedSavingsBytes,
        actualSavings: actualSavingsBytes,
        artifactCount,
      });
      return undefined;
    }
    const messages = applyReplacements(input.plan.messages, replacements);
    this.logSummary(input, {
      outcome: 'candidate_ready',
      totalTextBytes: input.plan.totalTextBytes,
      effectiveTextBytes: input.plan.totalTextBytes - actualSavingsBytes,
      candidateCount: input.plan.candidates.length,
      estimatedSavings: input.plan.estimatedSavingsBytes,
      actualSavings: actualSavingsBytes,
      artifactCount,
    });
    return { messages, actualSavingsBytes };
  }

  private async buildReplacements(
    input: { readonly sessionId: string },
    candidates: readonly ToolResultArchivePlanCandidate[],
  ): Promise<ToolResultArchiveReplacement[]> {
    const replacements: ToolResultArchiveReplacement[] = [];
    for (const candidate of candidates) {
      const replacement = await this.buildReplacement(input, candidate);
      if (replacement) replacements.push(replacement);
    }
    return replacements;
  }

  private async buildReplacement(
    input: { readonly sessionId: string },
    candidate: ToolResultArchivePlanCandidate,
  ): Promise<ToolResultArchiveReplacement | undefined> {
    const artifact = await this.resolveArtifactReference(input, candidate);
    if (!artifact) return undefined;

    const receipt = buildReceipt(artifact.reference, candidate.call, artifact.readFormat);
    const receiptBytes = Buffer.byteLength(receipt);
    if (receiptBytes >= candidate.visibleTextBytes) {
      return undefined;
    }
    const media = candidate.message.content.filter((block) => block.type !== 'text');
    return {
      key: candidate.key,
      index: candidate.index,
      message: {
        ...candidate.message,
        content: [{ type: 'text', text: receipt }, ...media],
      },
      receiptBytes,
      artifactCreated: artifact.created,
    };
  }

  private async resolveArtifactReference(
    input: { readonly sessionId: string },
    candidate: ToolResultArchivePlanCandidate,
  ): Promise<
    | {
        readonly reference: string;
        readonly readFormat?: string;
        readonly created: boolean;
      }
    | undefined
  > {
    if (candidate.existingReference) {
      return {
        reference: candidate.existingReference,
        ...(candidate.existingReadFormat ? { readFormat: candidate.existingReadFormat } : {}),
        created: false,
      };
    }
    const text = readToolResultText(candidate.message);
    const memoKey = artifactMemoKey(input.sessionId, candidate.call, text);
    const memoized = this.readMemo(memoKey);
    if (memoized) {
      const readFormat = nonEmptyString(memoized.metadata?.read_format);
      return {
        reference: memoized.reference,
        ...(readFormat ? { readFormat } : {}),
        created: false,
      };
    }
    try {
      const artifact = await this.options.writeArtifact({
        sessionId: input.sessionId,
        toolCallId: candidate.call.id,
        toolName: candidate.call.name,
        args: candidate.call.arguments,
        text,
        originalBytes: candidate.snapshotBytes,
        sensitive: false,
      });
      const reference = nonEmptyString(artifact.reference);
      if (!reference) return undefined;
      this.writeMemo(memoKey, artifact);
      const readFormat = nonEmptyString(artifact.metadata?.read_format);
      return {
        reference,
        ...(readFormat ? { readFormat } : {}),
        created: true,
      };
    } catch (error) {
      logBestEffort(this.options.logger, 'error', {
        event: 'tool_result_compaction_artifact_failed',
        session_id: input.sessionId,
        tool_name: candidate.call.name,
        reason: safeErrorReason(error),
      });
      return undefined;
    }
  }

  private readMemo(key: string): ToolResultArtifact | undefined {
    const artifact = this.references.get(key);
    if (!artifact) return undefined;
    this.references.delete(key);
    this.references.set(key, artifact);
    return artifact;
  }

  private writeMemo(key: string, artifact: ToolResultArtifact): void {
    this.references.set(key, artifact);
    while (this.references.size > this.referenceMemoEntries) {
      const oldest = this.references.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.references.delete(oldest);
    }
  }

  private logSummary(
    input: { readonly sessionId: string },
    summary: {
      readonly outcome: string;
      readonly totalTextBytes: number;
      readonly effectiveTextBytes: number;
      readonly candidateCount: number;
      readonly estimatedSavings: number;
      readonly actualSavings: number;
      readonly artifactCount: number;
    },
  ): void {
    logBestEffort(this.options.logger, 'info', {
      event: 'tool_result_compaction_candidate',
      session_id: input.sessionId,
      outcome: summary.outcome,
      tool_result_text_bytes_before: summary.totalTextBytes,
      tool_result_text_bytes_effective: summary.effectiveTextBytes,
      candidate_count: summary.candidateCount,
      estimated_savings_bytes: summary.estimatedSavings,
      actual_savings_bytes: summary.actualSavings,
      artifact_write_count: summary.artifactCount,
    });
  }
}

function buildTrimReplacement(
  candidate: ToolResultArchivePlanCandidate,
): ToolResultArchiveReplacement {
  const media = candidate.message.content.filter((block) => block.type !== 'text');
  return {
    key: candidate.key,
    index: candidate.index,
    message: {
      ...candidate.message,
      content: [{ type: 'text', text: TOOL_RESULT_TRIM_RECEIPT }, ...media],
    },
    receiptBytes: Buffer.byteLength(TOOL_RESULT_TRIM_RECEIPT),
    artifactCreated: false,
  };
}

function applyReplacements(
  messages: readonly AgentMessage[],
  replacements: readonly ToolResultArchiveReplacement[],
): readonly AgentMessage[] {
  if (replacements.length === 0) return messages;
  const replacementsByIndex = new Map(
    replacements.map((replacement) => [replacement.index, replacement.message]),
  );
  return messages.map((message, index) => replacementsByIndex.get(index) ?? message);
}

function estimateSavings(candidates: readonly ToolResultArchivePlanCandidate[]): number {
  return candidates.reduce(
    (total, candidate) =>
      total + Math.max(0, candidate.visibleTextBytes - TOOL_RESULT_ARCHIVE_RECEIPT_ESTIMATE_BYTES),
    0,
  );
}

function calculateActualSavings(
  candidates: readonly ToolResultArchivePlanCandidate[],
  replacements: readonly ToolResultArchiveReplacement[],
): number {
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  return replacements.reduce((total, replacement) => {
    const candidate = candidatesByKey.get(replacement.key);
    return total + (candidate ? candidate.visibleTextBytes - replacement.receiptBytes : 0);
  }, 0);
}

function selectCandidates(
  messages: readonly AgentMessage[],
  minCandidateBytes: number,
  keepRecentRounds: number,
): ToolResultArchivePlanCandidate[] {
  const rounds = parseToolRounds(messages, { allowIncompleteTail: true });
  const settledRounds = rounds.filter((round) => round.settled);
  const protectedRounds = new Set([
    ...rounds.filter((round) => !round.settled),
    ...settledRounds.slice(-keepRecentRounds),
  ]);
  return rounds.flatMap((round) => {
    if (protectedRounds.has(round)) return [];
    return round.resultIndexes.flatMap((index) => {
      const candidate = buildArchiveCandidate(messages, round, index, minCandidateBytes);
      return candidate ? [candidate] : [];
    });
  });
}

function buildArchiveCandidate(
  messages: readonly AgentMessage[],
  round: ToolRound,
  index: number,
  minCandidateBytes: number,
): ToolResultArchivePlanCandidate | undefined {
  const eligible = readEligibleToolResult(messages, round, index);
  if (!eligible) return undefined;
  const { message, call } = eligible;
  const visibleTextBytes = measureToolResultTextBytes(message);
  if (visibleTextBytes < minCandidateBytes) return undefined;
  const budget = readToolOutputBudget(message.details);
  return {
    key: archiveCandidateKey(call),
    index,
    message,
    call,
    visibleTextBytes,
    snapshotBytes: budget.reference ? (budget.originalBytes ?? visibleTextBytes) : visibleTextBytes,
    ...(budget.reference ? { existingReference: budget.reference } : {}),
    ...(budget.readFormat ? { existingReadFormat: budget.readFormat } : {}),
  };
}

function archiveCandidateKey(call: ToolCallIdentity): string {
  return `${call.id}\0${canonicalToolName(call.name)}`;
}

function readEligibleToolResult(
  messages: readonly AgentMessage[],
  round: ToolRound,
  index: number,
): { readonly message: ToolResultMessage; readonly call: ToolCallIdentity } | undefined {
  const message = messages[index];
  if (!message || message.role !== 'toolResult' || message.isError) return undefined;
  const callId = nonEmptyString(message.toolCallId);
  const call = callId ? round.toolCallsById.get(callId) : undefined;
  if (!call || CONTROL_TOOL_NAMES.has(canonicalToolName(call.name))) return undefined;
  return { message, call };
}

function countToolResultTextBytes(messages: readonly AgentMessage[]): number {
  return messages.reduce(
    (total, message) =>
      message.role === 'toolResult' ? total + measureToolResultTextBytes(message) : total,
    0,
  );
}

function readToolResultText(message: ToolResultMessage): string {
  const blocks = textBlocks(message);
  if (blocks.length === 1) return blocks[0]?.text ?? '';
  return blocks.map((block) => block.text).join('\n');
}

function measureToolResultTextBytes(message: ToolResultMessage): number {
  const blocks = textBlocks(message);
  return (
    blocks.reduce((bytes, block) => bytes + Buffer.byteLength(block.text), 0) +
    Math.max(0, blocks.length - 1)
  );
}

function textBlocks(message: ToolResultMessage) {
  return message.content.filter(
    (block): block is Extract<(typeof message.content)[number], { readonly type: 'text' }> =>
      block.type === 'text',
  );
}

function readToolOutputBudget(details: unknown): {
  readonly reference?: string;
  readonly originalBytes?: number;
  readonly readFormat?: string;
} {
  if (!isRecord(details)) return {};
  const budget = details.tool_output_budget;
  if (!isRecord(budget)) return {};
  const reference = nonEmptyString(budget.reference);
  const originalBytes = positiveFiniteInteger(budget.original_bytes);
  const readFormat = nonEmptyString(budget.read_format);
  return {
    ...(reference ? { reference } : {}),
    ...(originalBytes ? { originalBytes } : {}),
    ...(readFormat ? { readFormat } : {}),
  };
}

function buildReceipt(reference: string, call: ToolCallIdentity, readFormat?: string): string {
  const toolName =
    truncateUtf8(canonicalToolName(call.name), TOOL_RESULT_ARCHIVE_RECEIPT_TOOL_NAME_MAX_BYTES) ||
    'tool';
  const source = readReceiptSource(call);
  const sourceLine = source
    ? `Source: ${truncateUtf8(source, TOOL_RESULT_ARCHIVE_RECEIPT_SOURCE_MAX_BYTES)}\n`
    : '';
  const format =
    readFormat === CHUNKED_JSONL_READ_FORMAT ? `\nFormat: ${CHUNKED_JSONL_READ_FORMAT}` : '';
  return `[Earlier tool output externalized
Tool: ${toolName}
${sourceLine}Artifact: ${reference}${format}
Archived reference only; not evidence.]`;
}

function readReceiptSource(call: ToolCallIdentity): string | undefined {
  const args = call.arguments;
  if (!isRecord(args)) return undefined;
  if (canonicalToolName(call.name) === 'grep') {
    const pattern = readReceiptSourceField(args, 'pattern');
    const path = readReceiptSourceField(args, 'path') ?? readReceiptSourceField(args, 'file_path');
    const grepSource = [pattern, path]
      .filter((field): field is string => Boolean(field))
      .join('; ');
    if (grepSource) return grepSource;
  }
  for (const key of ['query', 'url', 'pattern', 'path', 'file_path'] as const) {
    const source = readReceiptSourceField(args, key);
    if (source) return source;
  }
  return undefined;
}

function readReceiptSourceField(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeReceiptSourceValue(key, value.slice(0, 1_024));
  return normalized ? `${key}=${JSON.stringify(normalized)}` : undefined;
}

function normalizeReceiptSourceValue(key: string, value: string): string {
  const normalized = value.replaceAll(/\s+/gu, ' ').trim();
  if (key !== 'url') return normalized;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return normalized;
    const hostname = url.hostname.replace(/^www\./u, '');
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const lastSegment = pathSegments.at(-1);
    const genericLeaf = lastSegment ? /^index\.(?:aspx?|html?|php)$/iu.test(lastSegment) : false;
    const semanticPath = pathSegments.slice(genericLeaf ? -2 : -1).join('/');
    return semanticPath ? `${hostname}/…/${semanticPath}` : hostname;
  } catch {
    return normalized;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const ellipsis = '…';
  const ellipsisBytes = Buffer.byteLength(ellipsis);
  if (maxBytes <= ellipsisBytes) return '';
  let result = '';
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (usedBytes + characterBytes + ellipsisBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result ? result + ellipsis : '';
}

function artifactMemoKey(sessionId: string, call: ToolCallIdentity, text: string): string {
  return createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(call.id)
    .update('\0')
    .update(call.name)
    .update('\0')
    .update(text)
    .digest('hex');
}

function canonicalToolName(name: string): string {
  return name.trim().toLowerCase();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveFiniteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function resolveToolResultCompactionConfig(
  config: ToolResultCompactionConfig | undefined,
): ResolvedToolResultCompactionConfig {
  return {
    enabled: typeof config?.enabled === 'boolean' ? config.enabled : TOOL_RESULT_ARCHIVE_ENABLED,
    watermarkBytes:
      positiveFiniteInteger(config?.watermarkBytes) ?? TOOL_RESULT_ARCHIVE_WATERMARK_BYTES,
    minSavingsBytes:
      positiveFiniteInteger(config?.minSavingsBytes) ?? TOOL_RESULT_ARCHIVE_MIN_SAVINGS_BYTES,
    minCandidateBytes:
      positiveFiniteInteger(config?.minCandidateBytes) ?? TOOL_RESULT_ARCHIVE_MIN_CANDIDATE_BYTES,
    keepRecentRounds:
      positiveFiniteInteger(config?.keepRecentRounds) ?? TOOL_RESULT_ARCHIVE_KEEP_RECENT_ROUNDS,
  };
}

function readToolResultCompactionConfig(
  getConfig: (() => ToolResultCompactionConfig | undefined) | undefined,
): ToolResultCompactionConfig | undefined {
  try {
    return getConfig?.();
  } catch {
    return undefined;
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ToolResultArchiver: ${field} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function logBestEffort(
  logger: Pick<PiTurnRunnerLogger, 'info' | 'error'> | undefined,
  level: 'info' | 'error',
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger?.[level]?.(fields, '[local-runtime-v2] ToolResult compaction');
  } catch {
    // Diagnostics must never change context compaction.
  }
}

function safeErrorReason(error: unknown): string {
  if (isRecord(error) && nonEmptyString(error.code)) return nonEmptyString(error.code) ?? 'error';
  return error instanceof Error && error.name ? error.name : 'unknown_error';
}
