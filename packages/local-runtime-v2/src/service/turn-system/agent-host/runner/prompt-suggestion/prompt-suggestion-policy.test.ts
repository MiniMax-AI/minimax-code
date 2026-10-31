import { describe, expect, it } from 'vitest';

import {
  evaluatePromptSuggestionPolicy,
  PROMPT_SUGGESTION_VERSION,
  promptSuggestionInstruction,
  type PromptSuggestionPolicy,
} from './prompt-suggestion-policy.js';

const allowAll: PromptSuggestionPolicy = {
  killSwitch: false,
  sampleRate: 1,
};

describe('prompt suggestion policy', () => {
  it('refuses everything when the kill switch is on, whatever else allows it', () => {
    expect(
      evaluatePromptSuggestionPolicy(
        { killSwitch: true, sampleRate: 1 },
        { sessionId: 'session-1' },
      ),
    ).toEqual({ allowed: false, reason: 'kill_switch' });
  });

  it('fails closed on a malformed or non-positive sample rate', () => {
    for (const sampleRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        evaluatePromptSuggestionPolicy({ ...allowAll, sampleRate }, { sessionId: 'session-1' }),
      ).toEqual({ allowed: false, reason: 'not_sampled' });
    }
  });

  it('samples a session stably instead of flipping between turns', () => {
    const policy = { ...allowAll, sampleRate: 0.5 };
    const decision = (sessionId: string) => evaluatePromptSuggestionPolicy(policy, { sessionId });
    // Repeated calls, standing in for successive turns, never disagree.
    for (const sessionId of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const first = decision(sessionId);
      expect(decision(sessionId)).toEqual(first);
      expect(decision(sessionId)).toEqual(first);
    }
    // A partial rollout must actually exclude some sessions, otherwise the rate
    // is decorative.
    const verdicts = Array.from(
      { length: 200 },
      (_, index) => decision(`session-${index}`).allowed,
    );
    expect(verdicts.some((allowed) => allowed)).toBe(true);
    expect(verdicts.some((allowed) => !allowed)).toBe(true);
  });

  it('binds the version to the exact instruction text', () => {
    expect(PROMPT_SUGGESTION_VERSION).toBe('task-next-action-v2');
    expect(promptSuggestionInstruction(PROMPT_SUGGESTION_VERSION)).toContain(
      'Suggest one concrete next action',
    );
    // An unknown version yields no text, so a result can never be published under
    // a version that did not produce it.
    expect(promptSuggestionInstruction('task-next-action-v1')).toBe('');
    expect(promptSuggestionInstruction('anything-else')).toBe('');
  });
});
