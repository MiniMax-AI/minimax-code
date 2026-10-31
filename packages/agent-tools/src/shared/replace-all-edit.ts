/**
 * Shared helper for `edit` tools when `replace_all: true`.
 *
 * pi's underlying `createEditTool` only models one-off unique-match edits
 * (`edits: [{ oldText, newText }]`), so to express `replace_all` semantics
 * we collapse every occurrence of `old_string` into a single full-file
 * replacement that pi's own edit pipeline can still drive — same BOM
 * stripping, line-ending restoration, unified-diff output, and
 * `withFileMutationQueue` locking. The wrapper performs the find + join
 * here; pi does the read-verify-write on the (now unique) full content
 * edit.
 */

import { normalizeToLF, stripBom } from '@earendil-works/pi-coding-agent/tools';

import { readFile as fsReadFile } from 'fs/promises';

export interface ReplaceAllEditInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
  replacedCount: number;
}

export class ReplaceAllError extends Error {
  constructor(
    message: string,
    public readonly code: 'OLD_STRING_EMPTY' | 'OLD_STRING_NOT_FOUND' | 'READ_FAILED',
  ) {
    super(message);
    this.name = 'ReplaceAllError';
  }
}

/**
 * Build the single full-file edit pi's edit tool expects to represent a
 * `replace_all: true` call. We read the file ourselves, count occurrences
 * of `old_string`, and rewrite the content in one shot. The returned
 * `replacedCount` lets the caller surface a meaningful success message
 * (the model's UX is "I replaced N occurrences") even though pi only ever
 * sees one edit.
 *
 * Counting and replacing happen in pi's edit space: BOM stripped and line
 * endings normalized to LF, exactly like pi's edit does before matching.
 * The returned edit lives in that space too, so pi matches it against the
 * whole normalized file and restores the original BOM and line endings
 * when it writes.
 */
export async function buildReplaceAllEdit(
  absolutePath: string,
  oldString: string,
  newString: string,
): Promise<ReplaceAllEditInput> {
  if (oldString === '') {
    throw new ReplaceAllError(
      `replace_all: old_string must be non-empty (path=${absolutePath}).`,
      'OLD_STRING_EMPTY',
    );
  }

  let rawContent: string;
  try {
    const buffer = await fsReadFile(absolutePath);
    rawContent = buffer.toString('utf-8');
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    throw new ReplaceAllError(
      `Could not read file for replace_all: ${absolutePath}. ${code ?? String(err)}.`,
      'READ_FAILED',
    );
  }

  const content = normalizeToLF(stripBom(rawContent).text);
  const needle = normalizeToLF(oldString);
  const replacement = normalizeToLF(newString);

  let replacedCount = 0;
  {
    let cursor = 0;
    while ((cursor = content.indexOf(needle, cursor)) !== -1) {
      replacedCount += 1;
      cursor += needle.length;
    }
  }

  if (replacedCount === 0) {
    throw new ReplaceAllError(
      `replace_all: old_string was not found in ${absolutePath}.`,
      'OLD_STRING_NOT_FOUND',
    );
  }

  const newContent = rawStringReplaceAll(content, needle, replacement);

  return {
    path: absolutePath,
    edits: [{ oldText: content, newText: newContent }],
    replacedCount,
  };
}

/**
 * pi reports the collapsed full-file edit as "Successfully replaced 1
 * block(s)", which tells the model only one spot changed. Replace pi's
 * success text with the real occurrence count; non-text content and
 * details (diff / patch) are kept as-is.
 */
export function withReplaceAllCount<T extends { content: ReadonlyArray<{ type: string }> }>(
  result: T,
  path: string,
  replacedCount: number,
): T {
  const text = `Successfully replaced ${replacedCount} occurrence(s) in ${path}.`;
  return {
    ...result,
    content: [{ type: 'text', text }, ...result.content.filter((item) => item.type !== 'text')],
  };
}

/**
 * `String.prototype.replaceAll` exists on Node 15+; we keep a tiny
 * `split().join()` fallback here for environments where the runtime
 * shim strips it (older electron preload, jsdom test runners, etc.).
 */
function rawStringReplaceAll(haystack: string, needle: string, replacement: string): string {
  if (typeof haystack.replaceAll === 'function') {
    // A callback keeps replacement text literal instead of expanding $ sequences.
    return haystack.replaceAll(needle, () => replacement);
  }
  return haystack.split(needle).join(replacement);
}
