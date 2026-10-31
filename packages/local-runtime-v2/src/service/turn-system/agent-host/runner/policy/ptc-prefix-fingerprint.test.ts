import { describe, expect, it, vi } from 'vitest';

import { comparePtcPrefix, fingerprintPtcPrefix } from './ptc-prefix-fingerprint.js';

const READ = { def: { name: 'read', description: 'Read a file.', schema: { type: 'object' } } };
const RUN_CODE = {
  def: { name: 'run_code', description: 'Run a program.', schema: { type: 'object' } },
};
const PREFIX = {
  systemPrompt: '# Tool calls in this turn (PTC)\nUse run_code.\n\n# Harness\n- rules',
  tools: [RUN_CODE],
  nativeCatalog: [READ],
};
const SAME = fingerprintPtcPrefix(PREFIX);
const CHANGED = fingerprintPtcPrefix({ ...PREFIX, tools: [RUN_CODE, READ] });
const CHANGED_AGAIN = fingerprintPtcPrefix({ ...PREFIX, tools: [READ, RUN_CODE] });
/** MAX_TRACKED_SESSIONS in ptc-prefix-fingerprint.ts. */
const TRACKED_SESSIONS = 512;

describe('PTC prefix baselines per process', () => {
  it('drops the least recently observed Session first, and its next Turn only sets a baseline', () => {
    const warn = vi.fn();
    const observe = (sessionId: string, turnId: string, fingerprint = SAME) =>
      comparePtcPrefix({ sessionId, turnId, source: 'api', fingerprint }, { warn });

    observe('lru-a', 'turn-1');
    observe('lru-b', 'turn-1');
    // A Turn of A makes B the least recently observed Session.
    observe('lru-a', 'turn-2');
    for (let index = 0; index < TRACKED_SESSIONS - 1; index += 1) {
      observe(`lru-filler-${String(index)}`, 'turn-1');
    }
    expect(warn).not.toHaveBeenCalled();

    // A stayed tracked through the overflow and still compares.
    observe('lru-a', 'turn-3', CHANGED);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ session_id: 'lru-a', previous_turn_id: 'turn-2' }),
      'ptc prefix changed',
    );

    // B was dropped: its next Turn starts a new baseline instead of warning.
    observe('lru-b', 'turn-2', CHANGED);
    expect(warn).toHaveBeenCalledOnce();
    observe('lru-b', 'turn-3', CHANGED_AGAIN);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ session_id: 'lru-b', previous_turn_id: 'turn-2' }),
      'ptc prefix changed',
    );
  });
});
