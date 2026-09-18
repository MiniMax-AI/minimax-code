import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalEditTool } from '../desktop/local-pi-tools.js';
import { buildReplaceAllEdit } from './replace-all-edit.js';

const replacements = ['$$', '$&', '$`', "$'"];

describe('literal edit replacement text', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'literal-edit-'));
    file = join(directory, 'example.txt');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(replacements)(
    'builds a literal full-file replacement for %s',
    async (replacement) => {
      const original = 'before TOKEN after\nTOKEN\n';
      await writeFile(file, original);

      const result = await buildReplaceAllEdit(file, 'TOKEN', replacement);

      expect(result).toEqual({
        path: file,
        edits: [
          {
            oldText: original,
            newText: `before ${replacement} after\n${replacement}\n`,
          },
        ],
        replacedCount: 2,
      });
      expect(await readFile(file, 'utf8')).toBe(original);
    },
  );

  describe.each([true, false])('LocalEditTool with replace_all=%s', (replaceAll) => {
    it.each(replacements)('writes %s literally to disk', async (replacement) => {
      await writeFile(
        file,
        replaceAll ? 'before TOKEN after\nTOKEN\n' : 'before TOKEN after\n',
      );

      const result = await new LocalEditTool(directory).execute(
        { sessionId: 'literal-edit-session', turnId: 'literal-edit-turn' },
        {
          file_path: 'example.txt',
          old_string: 'TOKEN',
          new_string: replacement,
          replace_all: replaceAll,
        },
      );

      expect(await readFile(file, 'utf8')).toBe(
        replaceAll
          ? `before ${replacement} after\n${replacement}\n`
          : `before ${replacement} after\n`,
      );
      expect(result.text).toContain('Successfully replaced');
    });
  });
});
