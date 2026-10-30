import {
  bindTool,
  type ToolImpl,
  type ToolResult,
  withProgrammaticResult,
} from '@mavis/agent-core/tools';

import { LocalWebFetchToolDef, type LocalWebFetchToolInput } from './builtin-defs.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
import type { LocalRuntimeToolContext, LocalWebFetchAdapter } from './types.js';

const WEB_FETCH_MAX_RESULT_TOKENS = 16_000;
const MAX_BINARY_SEARCH_ITERATIONS = 64;

@bindTool(LocalWebFetchToolDef)
export class LocalWebFetchTool implements ToolImpl<
  typeof LocalWebFetchToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalWebFetchAdapter) {}

  async execute(
    _ctx: LocalRuntimeToolContext,
    input: LocalWebFetchToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const resp = await this.adapter.fetch(input, signal);
    const retrievalOutcome = resp.retrievalOutcome;

    const statusCode = resp.base_resp?.status_code ?? 0;
    if (statusCode !== 0) {
      const text = resp.base_resp?.status_msg ?? 'local web_fetch adapter returned non-zero status';
      // A failed fetch is an error result, so neither the model nor a program
      // takes the error text for page content; details stay as they were.
      return withProgrammaticResult(
        {
          tool_name: LocalWebFetchToolDef.name,
          text,
          content: [{ type: 'text', text }],
          isError: true,
          details: {
            ok: false,
            url: input.url,
            status_code: statusCode,
            ...(resp.status !== undefined ? { http_status: resp.status } : {}),
            ...(resp.statusText ? { http_status_text: resp.statusText } : {}),
            ...(resp.contentType ? { content_type: resp.contentType } : {}),
            ...(resp.retryAfter ? { retry_after: resp.retryAfter } : {}),
            ...(retrievalOutcome ? { retrieval_outcome: retrievalOutcome } : {}),
          },
        },
        {
          data: {
            url: input.url,
            ...(resp.status !== undefined ? { httpStatus: resp.status } : {}),
            ...(resp.retryAfter ? { retryAfter: resp.retryAfter } : {}),
          },
        },
      );
    }

    const clipped = truncateWebFetchContentByEstimatedTokens(
      resp.content ?? '',
      WEB_FETCH_MAX_RESULT_TOKENS,
    );
    const content = clipped.text;
    const result: ToolResult = {
      tool_name: LocalWebFetchToolDef.name,
      text: content,
      content: [{ type: 'text', text: content }],
      details: {
        ok: true,
        url: input.url,
        ...(resp.finalUrl ? { final_url: resp.finalUrl } : {}),
        ...(resp.status !== undefined ? { http_status: resp.status } : {}),
        ...(resp.statusText ? { http_status_text: resp.statusText } : {}),
        ...(resp.contentType ? { content_type: resp.contentType } : {}),
        ...(resp.retryAfter ? { retry_after: resp.retryAfter } : {}),
        ...(resp.bytes !== undefined ? { bytes: resp.bytes } : {}),
        ...(resp.truncated !== undefined || clipped.truncated
          ? { truncated: Boolean(resp.truncated || clipped.truncated) }
          : {}),
        ...(clipped.truncated
          ? {
              token_truncated: true,
              original_estimated_tokens: clipped.originalTokens,
              returned_estimated_tokens: clipped.returnedTokens,
              max_result_tokens: WEB_FETCH_MAX_RESULT_TOKENS,
            }
          : {}),
        ...(retrievalOutcome ? { retrieval_outcome: retrievalOutcome } : {}),
      },
    };
    // The adapter hands back an HTTP error page as a normal body (status_code 0),
    // so the final HTTP status decides failure here: a 4xx/5xx page must not be
    // read as the requested content. Text and details stay as they were; PTC
    // gets the failure data shape.
    if (resp.status !== undefined && resp.status >= 400) {
      return withProgrammaticResult(
        { ...result, isError: true },
        {
          data: {
            url: input.url,
            httpStatus: resp.status,
            ...(resp.retryAfter ? { retryAfter: resp.retryAfter } : {}),
          },
        },
      );
    }
    // The completeness statement and data for PTC; details and text are unchanged.
    // data.content is the text itself, so it is cut exactly where output is.
    const data = {
      url: input.url,
      ...(resp.finalUrl ? { finalUrl: resp.finalUrl } : {}),
      ...(resp.status !== undefined ? { httpStatus: resp.status } : {}),
      ...(resp.contentType ? { contentType: resp.contentType } : {}),
      ...(resp.bytes !== undefined ? { bytes: resp.bytes } : {}),
      content,
    };
    return withDesktopCompletenessReport(LocalWebFetchToolDef.name, result, { data });
  }
}

function truncateWebFetchContentByEstimatedTokens(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean; originalTokens: number; returnedTokens: number } {
  const originalTokens = estimateTextTokens(text);
  if (originalTokens <= maxTokens) {
    return { text, truncated: false, originalTokens, returnedTokens: originalTokens };
  }

  const marker = `\n\n[web_fetch response truncated: estimated ${originalTokens} tokens exceeded ${maxTokens}; omitted middle content.]\n\n`;
  const markerTokens = estimateTextTokens(marker);
  const contentBudget = Math.max(1, maxTokens - markerTokens);
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  const head = takePrefixByEstimatedTokens(text, headBudget);
  let tail = takeSuffixByEstimatedTokens(text, tailBudget);
  let clipped = `${head}${marker}${tail}`;

  for (
    let iterations = 0;
    estimateTextTokens(clipped) > maxTokens && tail.length > 0 && iterations < text.length;
    iterations += 1
  ) {
    tail = dropLeadingCodePoint(tail);
    clipped = `${head}${marker}${tail}`;
  }

  return {
    text: clipped,
    truncated: true,
    originalTokens,
    returnedTokens: estimateTextTokens(clipped),
  };
}

function takePrefixByEstimatedTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let lo = 0;
  let hi = text.length;
  let best = 0;
  for (let iterations = 0; lo <= hi && iterations < MAX_BINARY_SEARCH_ITERATIONS; iterations += 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTextTokens(text.slice(0, mid)) <= maxTokens) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, safePrefixEnd(text, best));
}

function takeSuffixByEstimatedTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let lo = 0;
  let hi = text.length;
  let best = text.length;
  for (let iterations = 0; lo <= hi && iterations < MAX_BINARY_SEARCH_ITERATIONS; iterations += 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTextTokens(text.slice(mid)) <= maxTokens) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return text.slice(safeSuffixStart(text, best));
}

function safePrefixEnd(text: string, index: number): number {
  if (index > 0 && isHighSurrogate(text.charCodeAt(index - 1))) return index - 1;
  return index;
}

function safeSuffixStart(text: string, index: number): number {
  if (index < text.length && isLowSurrogate(text.charCodeAt(index))) return index + 1;
  return index;
}

function dropLeadingCodePoint(text: string): string {
  if (!text) return '';
  const first = text.charCodeAt(0);
  return text.slice(isHighSurrogate(first) && isLowSurrogate(text.charCodeAt(1)) ? 2 : 1);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

const CJK_RE =
  /[\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}\u{AC00}-\u{D7AF}\u{20000}-\u{2FA1F}]/u;

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
