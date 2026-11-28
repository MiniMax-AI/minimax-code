import type { ToolResult } from '@mavis/agent-core/tools';

import { withDesktopCompletenessReport } from './ptc-result-projection.js';

const COMMAND = 'session messages';

/** One window of a `session messages` page's output, read by character offset. */
export interface MavisOutputWindow {
  readonly offset: number;
  /** Where the next window starts; null at the end of the output. */
  readonly next_offset: number | null;
  readonly total_chars: number;
  readonly text: string;
}

/**
 * `mavis session messages` with `offset`: the page's full output read in
 * consecutive windows, each the longest piece from `offset` whose tool result
 * stays within `maxTokens`. Every window but the last names the offset to
 * continue with, so a reader follows them to the end without a gap.
 */
export function sessionMessagesWindow(
  full: string,
  offset: number,
  estimateTokens: (text: string) => number,
  maxTokens: number,
): ToolResult {
  if (offset >= full.length && !(offset === 0 && full.length === 0)) {
    const text = JSON.stringify({
      ok: false,
      command: COMMAND,
      error: {
        kind: 'validation',
        message: `offset ${String(offset)} is past the end of this page's output (${String(full.length)} characters).`,
      },
    });
    return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
  }
  const window = nextWindow(full, offset, (text) => estimateTokens(text) <= maxTokens);
  const text = renderWindow(window);
  return withDesktopCompletenessReport(
    'mavis',
    {
      tool_name: 'mavis',
      text,
      content: [{ type: 'text', text }],
      details: { command: COMMAND, window },
    },
    { data: { ok: true, command: COMMAND, window } },
  );
}

function renderWindow(window: MavisOutputWindow): string {
  return `${windowHeader(window)}\n${window.text}`;
}

function windowHeader(window: Omit<MavisOutputWindow, 'text'>): string {
  const end = window.next_offset ?? window.total_chars;
  const range = `characters ${String(window.offset)}-${String(end)} of ${String(window.total_chars)} of this page's output`;
  return window.next_offset === null
    ? `[mavis session messages, ${range}; this is the end of the output]`
    : `[mavis session messages, ${range}; not finished: call again with the same session_id, source, limit and before, and continue with offset ${String(window.next_offset)}]`;
}

/** The longest window from `offset` whose rendered result fits. */
function nextWindow(
  full: string,
  offset: number,
  fits: (text: string) => boolean,
): MavisOutputWindow {
  const windowTo = (end: number): MavisOutputWindow => ({
    offset,
    next_offset: end >= full.length ? null : end,
    total_chars: full.length,
    text: full.slice(offset, end),
  });
  // Every window makes progress, even if one code point alone does not fit.
  let best = codePointEnd(full, offset);
  let low = best + 1;
  let high = full.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const end = safeEnd(full, mid);
    if (end > best && fits(renderWindow(windowTo(end)))) {
      best = end;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return windowTo(best);
}

/** The end of the first code point after `offset`. */
function codePointEnd(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  return Math.min(text.length, offset + (isHighSurrogate(text.charCodeAt(offset)) ? 2 : 1));
}

/** Never split a surrogate pair at the end of a window. */
function safeEnd(text: string, end: number): number {
  return end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
