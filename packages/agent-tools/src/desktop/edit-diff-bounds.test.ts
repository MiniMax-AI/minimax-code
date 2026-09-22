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
// this file took 167.5-173.5 s unbounded (the tool diffed the same input twice)
// and produced a diff no renderer displays; bounded it settles in 192-200 ms.
// Vitest's default 5 s timeout therefore also guards the bound: if it is ever
// removed, the whole-file case stops finishing in time.
const wholeFileRewriteLines = 20_000;

// Replacing a line costs 2 edits, so DIFF_MAX_EDIT_LENGTH (2000) admits a full
// rewrite of a file this long and omits anything longer.
const boundedRewriteLines = 1_000;

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
    expect(result.details?.patchOmitted).toBeUndefined();
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
    // The Compatible hook keeps the real hunks whenever the patch survives.
    const hunks = readPluginHookCompatibleToolResponse(result)?.structuredPatch as
      | readonly CompatibleHunk[]
      | undefined;
    expect(hunks?.length).toBeGreaterThan(0);
    expect(hunks?.some((hunk) => hunk.lines.includes('+const value0 = 1;'))).toBe(true);
  });

  // Rewriting a few hundred lines is an ordinary edit, not the pathological
  // case this bound targets: a reported 501-line whole-file replacement lost
  // its diff under the first bound this test pins.
  it('keeps the diff for a whole-file rewrite that fits the bound', async () => {
    const original = body(boundedRewriteLines, (index) => `const value${index} = ${index};`);
    const rewritten = body(boundedRewriteLines, (index) => `let renamed${index} = ${index * 2};`);
    await writeFile(file, original);

    const result = await new LocalEditTool(directory).execute(context, {
      file_path: 'subject.ts',
      old_string: original,
      new_string: rewritten,
    });

    expect(await readFile(file, 'utf8')).toBe(rewritten);
    expect(result.details?.diffOmitted).toBeUndefined();
    expect(result.details?.patchOmitted).toBeUndefined();
    expect(result.details?.patch).toContain('+let renamed0 = 0;');
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
    expect(result.details?.patchOmitted).toBe('too_many_changes');
    expect(result.details?.patch).toBeUndefined();
    expect(result.details?.diff).toContain('diff omitted');
  });

  // A Compatible PostToolUse handler is skipped with HOOK_INVALID_INPUT when
  // `structuredPatch` is missing, so dropping `details.patch` silently disabled
  // every such hook on exactly the edits this bound targets.
  it('sends the Compatible hook an empty structured patch when the patch is omitted', async () => {
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
    expect(response?.structuredPatch).toEqual([]);
  });

  // The runner rejects a serialized hook input over MAX_INPUT_BYTES (1 MiB), so
  // an unavailable patch has to degrade to something bounded: describing the
  // edit as one whole-file hunk grew this payload to 1 679 234 B against
  // 563 600 B here, and failed the same handler a second way. The response
  // separately carries `originalFile`, `oldString` and `newString` in full, so
  // this case keeps the edit strings small to isolate the patch field.
  it('keeps the Compatible hook payload under the runner input limit', async () => {
    const original = body(wholeFileRewriteLines, (index) => `const value${index} = ${index};`);
    await writeFile(file, original);
    // 1001 replaced lines cost 2002 edits, one past the bound.
    const oldBlock = body(1_001, (index) => `const value${index} = ${index};`);
    const newBlock = body(1_001, (index) => `const value${index} = ${index + 1};`);

    const result = await new LocalEditTool(directory).execute(context, {
      file_path: 'subject.ts',
      old_string: oldBlock,
      new_string: newBlock,
    });

    expect(result.details?.patchOmitted).toBe('too_many_changes');
    const response = readPluginHookCompatibleToolResponse(result);
    expect(response?.structuredPatch).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(1024 * 1024);
  });
});
