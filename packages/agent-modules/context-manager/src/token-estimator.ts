/**
 * Token estimation for {@link ContextLifecycleManager}.
 *
 * Why this exists
 * ---------------
 * pi-agent-core's `estimateTokens` / `estimateContextTokens` use `Math.ceil(chars / 4)`,
 * which severely under-counts CJK text — Chinese characters consume 1–2 BPE tokens each,
 * so chars/4 (≈0.25 tokens/char) under-reports by 4–8×. Under-reporting moves the
 * compaction trigger to the right, past the point at which Messages-compatible
 * providers reject the request (e.g. minimax's MiniMax-M2.7: rejects when
 * input > contextWindow - max_tokens).
 *
 * Pluggable interface
 * -------------------
 * {@link TokenEstimator} is the seam we own at the cloud-runtime layer.
 * {@link ContextLifecycleManager.evaluateTrigger} and selectFirstKeptIndex both
 * route through it. A future `count_tokens`-API-backed estimator can drop in
 * via constructor injection without touching manager logic.
 *
 * Ground-truth-aware estimate
 * ---------------------------
 * `estimateContextTokens` preserves pi-agent-core's good pattern:
 *  1. Find the last successful assistant message with usage for the current context;
 *  2. Trust its provider-reported total as the prefix sum;
 *  3. Estimate only the trailing messages after that point.
 * This bounds estimator error to the trailing window — typically a handful of
 * messages — rather than the entire conversation.
 *
 * Default implementation
 * ----------------------
 * {@link BpeTokenEstimator} uses gpt-tokenizer's `o200k_base` (GPT-4o BPE) for
 * bounded word runs and a UTF-8 byte upper bound for oversized word runs or
 * tokenizer failures. Long whitespace and symbol runs are counted in bounded
 * segments, because gpt-tokenizer merges one pre-tokenizer piece in quadratic
 * time. o200k_base is not the provider tokenizer, but for MiniMax /
 * Messages-compatible endpoints it consistently over-estimates a touch (safe:
 * earlier trigger), which is the direction we want when capacity
 * miscalculation means a hard 4xx.
 *
 * Per-message structural overhead (4 tokens) accounts for role wrappers and
 * delimiters the provider injects around each turn — exact count varies by API
 * (Messages-compatible API vs. OpenAI ChatCompletions), but 4 is in the right
 * ballpark and again biased to over-estimate.
 *
 * Visual content (`image` and legacy/raw `video` blocks) is charged 4_800
 * tokens to match pi-agent-core's image stand-in; real visual-token counts
 * depend on media dimensions and the active provider.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { countTokens as countO200kBase } from 'gpt-tokenizer/model/gpt-4o';
import type { ContextCompactionSummaryMessage } from './types.js';

export interface ContextTokenEstimate {
  /** Estimated total tokens consumed by `messages`. */
  tokens: number;
  /**
   * Provider-reported usage at the last successful assistant message — the
   * ground-truth portion of `tokens`. `0` when no assistant usage was found.
   */
  usageTokens: number;
  /**
   * Estimator-computed token count for messages after `lastUsageIndex`. When
   * `lastUsageIndex` is `null`, this equals `tokens` (full estimate).
   */
  trailingTokens: number;
  /** Index of the assistant message whose usage block was used, or `null`. */
  lastUsageIndex: number | null;
}

export interface TokenEstimator {
  /** Estimate tokens for raw text without message structural overhead. */
  estimateTextTokens(text: string): number;
  /** Return the shared stand-in used for one model-visible image/video block. */
  estimateVisualTokens(): number;
  /** Estimate tokens for a single message. */
  estimateMessage(message: AgentMessage): number;
  /** Estimate tokens for an arbitrary sequence of messages (no ground truth). */
  estimateMessages(messages: AgentMessage[]): number;
  /**
   * Estimate context tokens for a transcript, preferring provider usage as the
   * prefix ground-truth. Mirrors pi-agent-core's `estimateContextTokens`
   * contract so existing call sites can swap implementations without changing
   * downstream interpretation.
   */
  estimateContextTokens(messages: AgentMessage[]): ContextTokenEstimate;
}

/** Per-message structural overhead (role wrapper + delimiters). */
const MESSAGE_STRUCTURAL_OVERHEAD = 4;

/** Stand-in token count for an image or legacy/raw video block. */
const VISUAL_TOKEN_STAND_IN = 4_800;

/** Pluggable encoder seam — tests inject deterministic encoders. */
export type EncodeFn = (text: string) => number[] | Uint32Array;

const MAX_EXACT_TOKENIZER_CHARS = 4_096;
/**
 * Longest whitespace or symbol run sent to one tokenizer call. o200k keeps such
 * a run in a single pre-tokenizer piece and gpt-tokenizer merges a piece in
 * quadratic time: 32k repeated `⭐` took 4.4s, and model output looping on
 * `⭐` or U+3000 blocked the event loop for over a minute per request.
 */
const MAX_EXACT_SYMBOL_RUN_CHARS = 256;

const CHAR_CLASS_SPACE = 1;
const CHAR_CLASS_LETTER = 2;
const CHAR_CLASS_NUMBER = 3;
const CHAR_CLASS_MARK = 4;
const CHAR_CLASS_SYMBOL = 5;

const WHITESPACE = /\s/u;
const UNICODE_LETTER = /\p{L}/u;
const UNICODE_NUMBER = /\p{N}/u;
const UNICODE_MARK = /\p{M}/u;

let bmpCharClasses: Uint8Array | undefined;

function classifyCharacter(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint > 0xffff) return classifyUnicodeCharacter(character);
  bmpCharClasses ??= new Uint8Array(0x1_0000);
  const cached = bmpCharClasses[codePoint] ?? 0;
  if (cached !== 0) return cached;
  const charClass = classifyUnicodeCharacter(character);
  bmpCharClasses[codePoint] = charClass;
  return charClass;
}

function classifyUnicodeCharacter(character: string): number {
  if (WHITESPACE.test(character)) return CHAR_CLASS_SPACE;
  if (UNICODE_LETTER.test(character)) return CHAR_CLASS_LETTER;
  if (UNICODE_NUMBER.test(character)) return CHAR_CLASS_NUMBER;
  if (UNICODE_MARK.test(character)) return CHAR_CLASS_MARK;
  return CHAR_CLASS_SYMBOL;
}

/** A combining mark extends a letter or symbol piece and otherwise starts a letter piece. */
function pieceClassOf(charClass: number, previousPieceClass: number): number {
  if (charClass !== CHAR_CLASS_MARK) return charClass;
  return previousPieceClass === CHAR_CLASS_SYMBOL ? CHAR_CLASS_SYMBOL : CHAR_CLASS_LETTER;
}

/** o200k splits numbers into pieces of at most three digits, so their runs never need a cut. */
function maxRunLength(pieceClass: number): number {
  if (pieceClass === CHAR_CLASS_NUMBER) return Number.POSITIVE_INFINITY;
  if (pieceClass === CHAR_CLASS_LETTER) return MAX_EXACT_TOKENIZER_CHARS;
  return MAX_EXACT_SYMBOL_RUN_CHARS;
}

/**
 * Splits `text` at code-point boundaries so that no o200k pre-tokenizer piece
 * in a segment outgrows a bounded length. Runs follow the o200k piece classes:
 * whitespace, letters, numbers and everything else. Text without an oversized
 * run comes back as one segment, so its count is unchanged.
 *
 * Returns `undefined` for the legacy byte-bound case: a run of letters and
 * numbers longer than {@link MAX_EXACT_TOKENIZER_CHARS} code points.
 */
function splitIntoBoundedRuns(text: string): string[] | undefined {
  const segments: string[] = [];
  let segmentStart = 0;
  let offset = 0;
  let alphanumericRunLength = 0;
  let pieceClass = 0;
  let runLength = 0;
  for (const character of text) {
    const charClass = classifyCharacter(character);
    if (charClass === CHAR_CLASS_LETTER || charClass === CHAR_CLASS_NUMBER) {
      alphanumericRunLength += 1;
      if (alphanumericRunLength > MAX_EXACT_TOKENIZER_CHARS) return undefined;
    } else {
      alphanumericRunLength = 0;
    }
    const nextPieceClass = pieceClassOf(charClass, pieceClass);
    runLength = nextPieceClass === pieceClass ? runLength + 1 : 1;
    pieceClass = nextPieceClass;
    if (runLength > maxRunLength(pieceClass)) {
      segments.push(text.slice(segmentStart, offset));
      segmentStart = offset;
      runLength = 1;
    }
    offset += character.length;
  }
  segments.push(text.slice(segmentStart));
  return segments;
}

function estimateTextTokensUpperBound(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}

function isVisualContentBlock(block: { type?: unknown }): boolean {
  return block.type === 'image' || block.type === 'video';
}

function calculateContextTokens(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  contextTokens?: number;
}): number {
  return (
    usage.contextTokens ||
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

interface AssistantUsageRef {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  contextTokens?: number;
}

function getAssistantUsage(message: AgentMessage): AssistantUsageRef | undefined {
  if (message.role !== 'assistant') return undefined;
  const m = message as AgentMessage & {
    usage?: AssistantUsageRef;
    stopReason?: string;
  };
  if (m.stopReason === 'aborted' || m.stopReason === 'error') return undefined;
  return m.usage;
}

function getLastAssistantUsageInfo(
  messages: AgentMessage[],
): { usage: AssistantUsageRef; index: number } | undefined {
  let firstFreshIndex = 0;
  let compactedAt: number | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role !== 'compactionSummary') continue;
    const summary = messages[i] as ContextCompactionSummaryMessage;
    const keptCount = summary.keptMessageCount;
    if (keptCount !== undefined) {
      // Kept assistants appear AFTER the summary too. Only appended responses
      // describe the replacement context; their wall-clock timestamps may tie
      // or precede the summary if the clock changed.
      if (!Number.isSafeInteger(keptCount) || keptCount < 0) return undefined;
      firstFreshIndex = i + 1 + keptCount;
    } else {
      // Legacy persisted transcripts have no explicit retained-tail boundary.
      // Match the local runtime's conservative timestamp freshness rule.
      if (!Number.isFinite(summary.timestamp)) return undefined;
      compactedAt = summary.timestamp;
      firstFreshIndex = i + 1;
    }
    break;
  }
  for (let i = messages.length - 1; i >= firstFreshIndex; i -= 1) {
    const message = messages[i]!;
    if (
      compactedAt !== undefined &&
      (!Number.isFinite(message.timestamp) || message.timestamp <= compactedAt)
    ) {
      continue;
    }
    const usage = getAssistantUsage(message);
    if (usage) return { usage, index: i };
  }
  return undefined;
}

const MAX_INLINE_CACHE_KEY_UNITS = 256;
/**
 * The cloud runtime decodes stored history into fresh objects on every run, so
 * whole-history counts across runs reuse only this content-keyed cache. A cron
 * session held ~6.9k distinct texts: at 2_048 entries one pass evicted
 * everything it had counted and every later pass re-ran BPE over the whole
 * history. Keys are at most 261 UTF-16 units (inline text or a sha256 hex), so
 * the unit budget keeps the map to a few MB.
 */
const MAX_CACHED_TEXT_ENTRIES = 32_768;
const MAX_CACHED_TEXT_KEY_UNITS = 2_097_152;

interface TextCount {
  tokens: number;
  /** `false` when the tokenizer failed and the byte bound stands in for this call only. */
  reusable: boolean;
}

interface OwnedTextCount {
  text: string;
  tokens: number;
}

export class BpeTokenEstimator implements TokenEstimator {
  private readonly countExactTokens: (text: string) => number;
  // Bounded content keys survive detached histories without retaining long
  // message bodies. Hash UTF-16 units so lone surrogates stay distinct.
  private readonly textTokens = new Map<string, number>();
  private cachedTextKeyUnits = 0;
  // Whole-history passes over the same objects (checkpoint candidates, the
  // compaction trigger, usage) skip hashing and outlive LRU eviction while the
  // message is alive. The entry holds the block's own string and is compared on
  // read, so in-place edits are recounted.
  private readonly ownedTextTokens = new WeakMap<object, OwnedTextCount>();

  /**
   * @param encoder Override the default o200k_base tokenizer. Tests inject
   * deterministic encoders (e.g. `text => text.split(' ')`); production passes
   * no argument so the default GPT-4o BPE token counter is used.
   *
   * The default wraps gpt-tokenizer with `allowedSpecial: 'all'`. Without it,
   * gpt-tokenizer defaults to `disallowedSpecial: 'all'` and THROWS on any
   * special-token literal (e.g. `<|endoftext|>`) appearing in transcript text.
   * Since this estimator runs inside the fail-closed `beforeLlmCall` checkpoint,
   * such a throw would abort the whole turn. We only count tokens, so treating
   * special-token literals as ordinary text is correct here.
   */
  constructor(encoder?: EncodeFn) {
    this.countExactTokens = encoder
      ? (text) => encoder(text).length
      : (text) => countO200kBase(text, { allowedSpecial: 'all' });
  }

  estimateTextTokens(text: string): number {
    return this.countText(text).tokens;
  }

  private countText(text: string): TextCount {
    if (!text) return { tokens: 0, reusable: true };
    const key =
      text.length <= MAX_INLINE_CACHE_KEY_UNITS
        ? `text:${text}`
        : `sha256:${createHash('sha256').update(text, 'utf16le').digest('hex')}`;
    const cached = this.textTokens.get(key);
    if (cached !== undefined) {
      this.textTokens.delete(key);
      this.textTokens.set(key, cached);
      return { tokens: cached, reusable: true };
    }
    let tokens: number | undefined;
    try {
      tokens = this.countBoundedExactTokens(text);
    } catch {
      return { tokens: estimateTextTokensUpperBound(text), reusable: false };
    }
    if (tokens === undefined) {
      // An oversized letter run deterministically takes the byte bound.
      tokens = estimateTextTokensUpperBound(text);
    } else if (!Number.isFinite(tokens) || tokens < 0) {
      return { tokens: estimateTextTokensUpperBound(text), reusable: false };
    }
    this.rememberText(key, tokens);
    return { tokens, reusable: true };
  }

  private rememberText(key: string, tokens: number): void {
    while (
      this.textTokens.size > 0 &&
      (this.textTokens.size >= MAX_CACHED_TEXT_ENTRIES ||
        this.cachedTextKeyUnits + key.length > MAX_CACHED_TEXT_KEY_UNITS)
    ) {
      const oldest = this.textTokens.keys().next().value;
      if (oldest === undefined) break;
      this.textTokens.delete(oldest);
      this.cachedTextKeyUnits -= oldest.length;
    }
    this.textTokens.set(key, tokens);
    this.cachedTextKeyUnits += key.length;
  }

  /** Counts the one text field of `owner` (a content block, or a message with string content). */
  private estimateOwnedText(owner: object, text: string): number {
    const owned = this.ownedTextTokens.get(owner);
    if (owned !== undefined && owned.text === text) return owned.tokens;
    const count = this.countText(text);
    if (count.reusable) this.ownedTextTokens.set(owner, { text, tokens: count.tokens });
    else this.ownedTextTokens.delete(owner);
    return count.tokens;
  }

  /** `undefined` selects the UTF-8 byte upper bound. */
  private countBoundedExactTokens(text: string): number | undefined {
    if (text.length <= MAX_EXACT_SYMBOL_RUN_CHARS) return this.countExactTokens(text);
    const segments = splitIntoBoundedRuns(text);
    if (!segments) return undefined;
    let tokens = 0;
    for (const segment of segments) {
      const segmentTokens = this.countExactTokens(segment);
      if (!Number.isFinite(segmentTokens) || segmentTokens < 0) return undefined;
      tokens += segmentTokens;
    }
    return tokens;
  }

  estimateVisualTokens(): number {
    return VISUAL_TOKEN_STAND_IN;
  }

  estimateMessage(message: AgentMessage): number {
    let tokens = MESSAGE_STRUCTURAL_OVERHEAD;
    switch (message.role) {
      case 'user': {
        const content = (message as Extract<AgentMessage, { role: 'user' }>).content;
        if (typeof content === 'string') {
          tokens += this.estimateOwnedText(message, content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              tokens += this.estimateOwnedText(block, block.text);
            } else if (isVisualContentBlock(block)) {
              tokens += this.estimateVisualTokens();
            }
          }
        }
        return tokens;
      }
      case 'assistant': {
        const assistant = message as Extract<AgentMessage, { role: 'assistant' }>;
        for (const block of assistant.content) {
          if (block.type === 'text') {
            tokens += this.estimateOwnedText(block, block.text);
          } else if (block.type === 'thinking') {
            tokens += this.estimateOwnedText(block, (block as { thinking: string }).thinking);
          } else if (block.type === 'toolCall') {
            tokens += this.estimateTextTokens(block.name);
            tokens += this.estimateTextTokens(safeJsonStringify(block.arguments));
          }
        }
        return tokens;
      }
      case 'toolResult':
      case 'custom': {
        const content = (
          message as Extract<AgentMessage, { role: 'toolResult' | 'custom' }> & {
            content: string | Array<{ type: string; text?: string }>;
          }
        ).content;
        if (typeof content === 'string') {
          tokens += this.estimateOwnedText(message, content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              tokens += this.estimateOwnedText(block, block.text);
            } else if (isVisualContentBlock(block)) {
              tokens += this.estimateVisualTokens();
            }
          }
        }
        return tokens;
      }
      case 'bashExecution': {
        const m = message as AgentMessage & {
          command?: string;
          output?: string;
        };
        tokens += this.estimateTextTokens(m.command ?? '');
        tokens += this.estimateTextTokens(m.output ?? '');
        return tokens;
      }
      case 'branchSummary':
      case 'compactionSummary': {
        const m = message as AgentMessage & { summary?: string };
        tokens += this.estimateOwnedText(message, m.summary ?? '');
        return tokens;
      }
    }
    return tokens;
  }

  estimateMessages(messages: AgentMessage[]): number {
    let total = 0;
    for (const message of messages) {
      total += this.estimateMessage(message);
    }
    return total;
  }

  estimateContextTokens(messages: AgentMessage[]): ContextTokenEstimate {
    const info = getLastAssistantUsageInfo(messages);
    if (!info) {
      const trailing = this.estimateMessages(messages);
      return {
        tokens: trailing,
        usageTokens: 0,
        trailingTokens: trailing,
        lastUsageIndex: null,
      };
    }
    const usageTokens = calculateContextTokens(info.usage);
    let trailingTokens = 0;
    for (let i = info.index + 1; i < messages.length; i += 1) {
      trailingTokens += this.estimateMessage(messages[i]!);
    }
    return {
      tokens: usageTokens + trailingTokens,
      usageTokens,
      trailingTokens,
      lastUsageIndex: info.index,
    };
  }
}

/**
 * Default factory — single shared {@link BpeTokenEstimator} instance reusing
 * the module-loaded token counter.
 */
let defaultInstance: BpeTokenEstimator | undefined;
export function createDefaultTokenEstimator(): TokenEstimator {
  defaultInstance ??= new BpeTokenEstimator();
  return defaultInstance;
}

export function createDefaultContextTokenEstimator(): TokenEstimator {
  return createDefaultTokenEstimator();
}
