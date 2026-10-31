import { describe, expect, it } from 'vitest';

import { isTurnLifecycleMessageKind } from '../../src/turn-message-kind.js';

describe('turn message kind', () => {
  it.each([
    'compaction_start',
    'compaction',
    'compaction_failed',
    'review_start',
    'review_failed',
    'review_aborted',
    'review_interrupted',
  ])('treats %s as runtime lifecycle bookkeeping', (kind) => {
    expect(isTurnLifecycleMessageKind(kind)).toBe(true);
  });

  it.each([undefined, 'review_result', 'preamble', 'final'])(
    'keeps %s as a model response',
    (kind) => {
      expect(isTurnLifecycleMessageKind(kind)).toBe(false);
    },
  );
});
