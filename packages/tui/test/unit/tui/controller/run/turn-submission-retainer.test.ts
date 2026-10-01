import { describe, expect, it } from 'vitest';
import { TuiTurnSubmissionRetainer } from '../../../../../src/tui/controller/run/turn-submission-retainer.js';
import type { TuiSubmissionSnapshot } from '../../../../../src/tui/features/composer/submission.js';

function snapshot(id: string): TuiSubmissionSnapshot {
  return {
    submissionId: id,
    editor: { schemaVersion: 1, text: `text-${id}`, cursor: 6, pastes: [], pasteCounter: 0 },
    content: `text-${id}`,
    attachments: [],
    transportAttachments: [],
    createdAtMs: 0,
  };
}

describe('TuiTurnSubmissionRetainer', () => {
  it('remembers and returns snapshots by turn id', () => {
    const retainer = new TuiTurnSubmissionRetainer();
    retainer.remember('turn-1', snapshot('sub-1'));
    expect(retainer.get('turn-1')?.submissionId).toBe('sub-1');
    expect(retainer.get('turn-2')).toBeUndefined();
  });

  it('evicts the oldest entry beyond the cap and re-remembering bumps recency', () => {
    const retainer = new TuiTurnSubmissionRetainer();
    for (let index = 0; index < 8; index += 1) {
      retainer.remember(`turn-${index}`, snapshot(`sub-${index}`), index);
    }
    // Re-touch turn-3 so turn-1 becomes the oldest.
    retainer.remember('turn-3', snapshot('sub-3'), 99);
    retainer.remember('turn-new', snapshot('sub-new'), 100);
    expect(retainer.get('turn-0')).toBeUndefined();
    expect(retainer.get('turn-1')).toBeDefined();
    expect(retainer.get('turn-3')?.submissionId).toBe('sub-3');
    expect(retainer.get('turn-new')).toBeDefined();
  });

  it('drops individual entries and clears everything', () => {
    const retainer = new TuiTurnSubmissionRetainer();
    retainer.remember('turn-1', snapshot('sub-1'));
    retainer.remember('turn-2', snapshot('sub-2'));
    retainer.drop('turn-1');
    expect(retainer.get('turn-1')).toBeUndefined();
    retainer.clear();
    expect(retainer.get('turn-2')).toBeUndefined();
  });
});
