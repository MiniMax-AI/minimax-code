/**
 * edit-line-number-retry.ts — failure-only normalization bridging read's
 * line-numbered output (①) and pi edit's exact-match contract.
 *
 * Why (Codex Review !4027 P1): read output now prefixes every line with
 * `     N→`. A model that copies such a line verbatim into `edit.oldText`
 * used to get "oldText not found" with no recovery path, breaking the core
 * read→edit loop. This wrapper retries a failed pi edit exactly once with
 * the prefixes stripped — but only when EVERY non-empty line of the block
 * is prefix-shaped, and never on the first attempt, so files whose real
 * content looks line-numbered stay exactly editable.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { stripLineNumberPrefixesFromBlock } from './read-postprocess.js';

interface EditReplacement {
  oldText: string;
  newText: string;
}

interface EditInputShape {
  path: string;
  edits: EditReplacement[];
}

function isStorageExhausted(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, errno } = error as NodeJS.ErrnoException;
  return (
    code === 'EDQUOT' ||
    code === 'ENOSPC' ||
    (code === 'Unknown system error -122' && errno === -122)
  );
}

/**
 * Strip read line-number prefixes from every edit block that is fully
 * prefix-shaped. Returns null when nothing changed (no retry warranted).
 * newText is normalized too: a model pasting numbered lines as the
 * replacement would otherwise write `     2→…` into the file.
 */
export function normalizeEditsForLineNumberRetry(
  edits: readonly EditReplacement[],
): EditReplacement[] | null {
  let changed = false;
  const normalized = edits.map((edit) => {
    const oldText = stripLineNumberPrefixesFromBlock(edit.oldText) ?? edit.oldText;
    const newText = stripLineNumberPrefixesFromBlock(edit.newText) ?? edit.newText;
    if (oldText !== edit.oldText || newText !== edit.newText) changed = true;
    return { ...edit, oldText, newText };
  });
  return changed ? normalized : null;
}

/**
 * Execute a pi edit; on failure, retry once with line-number prefixes
 * stripped from the edit blocks. The retry result carries
 * `details.line_number_prefixes_stripped: true` for observability. If the
 * retry fails too (or nothing was normalizable), the ORIGINAL error is
 * rethrown — the model should see the failure for the text it actually
 * sent. Storage exhaustion is the exception: never retry it or hide it behind
 * an earlier text mismatch, since line-number normalization cannot fix it.
 */
export async function executeEditWithLineNumberRetry(
  tool: AgentTool,
  input: EditInputShape,
  signal?: AbortSignal,
): Promise<AgentToolResult<Record<string, unknown>>> {
  try {
    return await tool.execute('', input, signal);
  } catch (originalError) {
    if (signal?.aborted || isStorageExhausted(originalError)) throw originalError;
    const normalized = Array.isArray(input.edits)
      ? normalizeEditsForLineNumberRetry(input.edits)
      : null;
    if (!normalized) throw originalError;
    try {
      const res = await tool.execute('', { ...input, edits: normalized }, signal);
      return {
        ...res,
        details: {
          ...((res.details ?? {}) as Record<string, unknown>),
          line_number_prefixes_stripped: true,
        },
      };
    } catch (retryError) {
      if (isStorageExhausted(retryError)) throw retryError;
      throw originalError;
    }
  }
}
