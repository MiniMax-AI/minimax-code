import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalMemoryFacade } from '../../src/memory/local-memory-facade.js';
import { applyEdit } from '../../src/memory/local-memory-store-utils.js';

const literalReplacements = ['$&', '$$', '$`', "$'", '$$20'];

describe('literal memory edit replacement text', () => {
  it.each(literalReplacements)('inserts %s literally when replaceAll is false', (newString) => {
    expect(applyEdit('BEFORE TOKEN AFTER', 'TOKEN', newString, false)).toEqual({
      content: `BEFORE ${newString} AFTER`,
      replacements: 1,
    });
  });

  it('inserts every replacement literally when replaceAll is true', () => {
    expect(applyEdit('PAIR PAIR', 'PAIR', '$$', true)).toEqual({
      content: '$$ $$',
      replacements: 2,
    });
  });

  it('keeps the missing and ambiguous old_string guards', () => {
    expect(() => applyEdit('body', 'absent', 'x', false)).toThrowError(
      expect.objectContaining({ code: 'OLD_STRING_NOT_FOUND' }),
    );
    expect(() => applyEdit('TOKEN TOKEN', 'TOKEN', 'x', false)).toThrowError(
      expect.objectContaining({ code: 'OLD_STRING_AMBIGUOUS' }),
    );
  });

  it('edits Memory through the facade without rewriting $ patterns', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-memory-edit-literal-'));
    try {
      const facade = new LocalMemoryFacade({
        config: () => ({ dataDir, enabled: true }),
        nowMs: () => 1_700_000_000_000,
      });
      await facade.writeMemory('mavis', 'BEFORE TOKEN AFTER');

      await expect(facade.editMemory('mavis', 'TOKEN', '$&', false)).resolves.toEqual({
        replacements: 1,
        result: expect.objectContaining({ content: 'BEFORE $& AFTER' }),
      });
      await expect(facade.getAgentMemory('mavis')).resolves.toMatchObject({
        content: 'BEFORE $& AFTER',
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
