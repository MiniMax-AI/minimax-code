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

  let replacedCount = 0;
  {
    let cursor = 0;
    while ((cursor = rawContent.indexOf(oldString, cursor)) !== -1) {
      replacedCount += 1;
      cursor += oldString.length;
    }
  }

  if (replacedCount === 0) {
    throw new ReplaceAllError(
      `replace_all: old_string was not found in ${absolutePath}.`,
      'OLD_STRING_NOT_FOUND',
    );
  }

  const newContent = rawStringReplaceAll(rawContent, oldString, newString);

  return {
    path: absolutePath,
    edits: [{ oldText: rawContent, newText: newContent }],
    replacedCount,
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
