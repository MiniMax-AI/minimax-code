import { describe, expect, it } from 'vitest';
import type { CanonicalHistoryEnvelope } from '../sessions/representation/canonical-history-contract.js';
import { resolveSideHistoryBoundary } from './side-history-boundary.js';

const user: CanonicalHistoryEnvelope = {
  message_id: 'msg-user',
  turn_id: 'turn',
  message: { role: 'user', content: 'question', timestamp: 1 },
};
const call: CanonicalHistoryEnvelope = {
  message_id: 'msg-call',
  turn_id: 'turn',
  message: {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'tool', name: 'task_output', arguments: {} }],
    timestamp: 2,
  },
};
const result: CanonicalHistoryEnvelope = {
  message_id: 'msg-result',
  turn_id: 'turn',
  message: {
    role: 'toolResult',
    toolCallId: 'tool',
    toolName: 'task_output',
    content: [{ type: 'text', text: 'done' }],
    isError: false,
    timestamp: 3,
  },
};
function history(active: readonly CanonicalHistoryEnvelope[]) {
  return { active, activeGeneration: 0, snapshots: [], revision: 'r', activeSettled: false };
}

describe('side conversation history boundary', () => {
  it('exposes no boundary for an empty source', () => {
    expect(resolveSideHistoryBoundary(history([]))).toBeUndefined();
  });
  it('keeps a pinned prefix when later tool results arrive', () => {
    expect(resolveSideHistoryBoundary(history([user, call]))).toBe(user.message_id);
    expect(resolveSideHistoryBoundary(history([user, call, result]), user.message_id)).toBe(
      user.message_id,
    );
    expect(resolveSideHistoryBoundary(history([user, call, result]))).toBe(result.message_id);
  });
  it('rejects a pinned incomplete or missing boundary instead of choosing another', () => {
    expect(
      resolveSideHistoryBoundary(history([user, call, result]), call.message_id),
    ).toBeUndefined();
    expect(resolveSideHistoryBoundary(history([user, call, result]), 'missing')).toBeUndefined();
  });
  it('finds the pinned prefix after compaction moves it to an archive', () => {
    const archived = {
      ...history([]),
      activeGeneration: 1,
      snapshots: [
        {
          generation: 0,
          fileName: 'g000000000000--before.jsonl',
          revision: 'r0',
          records: [user, call, result],
        },
      ],
    };
    expect(resolveSideHistoryBoundary(archived, result.message_id)).toBe(result.message_id);
  });
  it('does not hide corrupt history by falling back to an older prefix', () => {
    expect(() => resolveSideHistoryBoundary(history([user, result]))).toThrow();
  });
});
