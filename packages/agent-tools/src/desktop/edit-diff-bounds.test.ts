import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPluginHookCompatibleToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { LocalEditTool } from './local-pi-tools.js';

interface CompatibleHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

const context = { sessionId: 'edit-diff-bounds-session', turnId: 'edit-diff-bounds-turn' };

// Myers costs O((N+M)·D) in the length D of the edit script, so a whole-file
// rewrite is quadratic in the number of changed lines. Rewriting every line of
// this file took 120-139 s unbounded (the tool diffed the same input twice) and
// produced a ~1.3 MB diff no renderer displays; bounded it settles in ~60 ms.
// Vitest's default 5 s timeout therefore also guards the bound: if it is ever
// removed, the whole-file case stops finishing in time.
const wholeFileRewriteLines = 20_000;

function body(lines: number, render: (index: number) => string): string {
  return `${Array.from({ length: lines }, (_, index) => render(index)).join('\n')}\n`;
}

describe('edit diff bounds', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'edit-diff-bounds-'));
    file = join(directory, 'subject.ts');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the diff and patch for an ordinary edit', async () => {
    await writeFile(file, 'const value = 1;\nconst other = 2;\n');

    const result = await new LocalEditTool(directory).execute(context, {
      file_path: 'subject.ts',
      old_string: 'const value = 1;',
      new_string: 'const value = 42;',
    });

    expect(await readFile(file, 'utf8')).toBe('const value = 42;\nconst other = 2;\n');
    expect(result.details?.diffOmitted).toBeUndefined();
    expect(result.details?.diff).toContain('const value = 42;');
    expect(result.details?.patch).toContain('@@');
    expect(result.details?.patch).toContain('+const value = 42;');
  });

  it('keeps the diff for a large but bounded block replacement', async () => {
    const original = body(wholeFileRewriteLines, (index) => `const value${index} = ${index};`);
    await writeFile(file, original);
    // 400 replaced lines cost 800 edits, which stays under the bound even
    // though the surrounding file is large: the bound tracks changed lines,
    // not file size.
    const oldBlock = body(400, (index) => `const value${index} = ${index};`);
    const newBlock = body(400, (index) => `const value${index} = ${index + 1};`);

    const result = await new LocalEditTool(directory).execute(context, {
      file_path: 'subject.ts',
      old_string: oldBlock,
      new_string: newBlock,
    });

    expect(await readFile(file, 'utf8')).toBe(`${newBlock}${original.slice(oldBlock.length)}`);
    expect(result.details?.diffOmitted).toBeUndefined();
    expect(result.details?.patch).toContain('@@');
  });

  it('omits the diff for a whole-file rewrite but still writes the file', async () => {
    const original = body(wholeFileRewriteLines, (index) => `const value${index} = ${index};`);
    const rewritten = body(wholeFileRewriteLines, (index) => `let renamed${index} = ${index * 2};`);
    await writeFile(file, original);

    const result = await new LocalEditTool(directory).execute(context, {
      file_path: 'subject.ts',
      old_string: original,
      new_string: rewritten,
    });

    // The edit itself must be unaffected: the diff is a receipt computed after
    // the write, so giving it up never changes what lands on disk.
    expect(await readFile(file, 'utf8')).toBe(rewritten);
    expect(result.isError).toBeFalsy();

    expect(result.details?.diffOmitted).toBe('too_many_changes');
    expect(result.details?.patch).toBeUndefined();
    expect(result.details?.diff).toContain('diff omitted');
  });

  // A Compatible PostToolUse handler is skipped with HOOK_INVALID_INPUT when
  // `structuredPatch` is missing, so dropping `details.patch` silently disabled
  // every such hook on exactly the edits this bound targets.
  it('still hands the Compatible hook a structured patch when the patch is omitted', async () => {
    const original = body(wholeFileRewriteLines, (index) => `const value${index} = ${index};`);
    const rewritten = body(wholeFileRewriteLines, (index) => `let renamed${index} = ${index * 2};`);
    await writeFile(file, original);

    const result = await new LocalEditTool(directory).execute(context, {
      file_path: 'subject.ts',
      old_string: original,
      new_string: rewritten,
    });

    expect(result.details?.patch).toBeUndefined();
    const response = readPluginHookCompatibleToolResponse(result);
    expect(response).toBeDefined();
    expect(response?.originalFile).toBe(original);
    const hunks = response?.structuredPatch as readonly CompatibleHunk[] | undefined;
    expect(hunks).toHaveLength(1);
    const hunk = hunks?.[0];
    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.oldLines).toBe(wholeFileRewriteLines);
    expect(hunk?.newLines).toBe(wholeFileRewriteLines);
    // Every old line is removed and every new line added, in that order.
    expect(hunk?.lines).toHaveLength(wholeFileRewriteLines * 2);
    expect(hunk?.lines[0]).toBe('-const value0 = 0;');
    expect(hunk?.lines[wholeFileRewriteLines - 1]).toBe(
      `-const value${wholeFileRewriteLines - 1} = ${wholeFileRewriteLines - 1};`,
    );
    expect(hunk?.lines[wholeFileRewriteLines]).toBe('+let renamed0 = 0;');
  });

  it('marks a missing trailing newline in the synthesized hunk', async () => {
    const original = body(wholeFileRewriteLines, (index) => `const value${index} = ${index};`);
    const rewritten = body(
      wholeFileRewriteLines,
      (index) => `let renamed${index} = ${index * 2};`,
    ).slice(0, -1);
    await writeFile(file, original);

    const result = await new LocalEditTool(directory).execute(context, {
      file_path: 'subject.ts',
      old_string: original,
      new_string: rewritten,
    });

    expect(await readFile(file, 'utf8')).toBe(rewritten);
    const hunks = readPluginHookCompatibleToolResponse(result)?.structuredPatch as
      | readonly CompatibleHunk[]
      | undefined;
    // jsdiff emits the marker after the side that lacks the newline; only the
    // new side does here, so it lands last.
    expect(hunks?.[0]?.lines.at(-1)).toBe('\\ No newline at end of file');
    expect(hunks?.[0]?.lines.filter((line) => line.startsWith('\\'))).toHaveLength(1);
  });
});
