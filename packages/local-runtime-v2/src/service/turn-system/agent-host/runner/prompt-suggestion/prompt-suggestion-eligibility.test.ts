import { describe, expect, it, vi } from 'vitest';

import {
  createPromptSuggestionEligibility,
  isEligibleMembership,
  type MembershipReader,
  type MembershipFacts,
} from './prompt-suggestion-eligibility.js';

type AuthSnapshot = ReturnType<MembershipReader['readAuthSnapshot']>;

const SIGNED_IN: AuthSnapshot = { accessToken: 'token-a', loginEpoch: 'epoch-1' };

function reader(
  facts: MembershipFacts | (() => never),
  snapshots: AuthSnapshot[] = [SIGNED_IN],
) {
  const readAuthSnapshot = vi.fn(() => snapshots.shift() ?? SIGNED_IN);
  const readMembershipFacts = vi.fn(async (signal?: AbortSignal) => {
    if (typeof facts === 'function') {
      return new Promise<MembershipFacts>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        facts();
      });
    }
    void signal;
    return facts;
  });
  return { readAuthSnapshot, readMembershipFacts };
}

describe('prompt suggestion subscription eligibility', () => {
  it('admits only a confirmed plan and never a balance-derived guess', () => {
    expect(isEligibleMembership({ hasTokenPlan: true, subscriptionType: 'none' })).toBe(true);
    expect(isEligibleMembership({ hasTokenPlan: false, subscriptionType: 'token_plan' })).toBe(true);
    expect(isEligibleMembership({ hasTokenPlan: false, subscriptionType: 'agent_plan' })).toBe(true);
    expect(isEligibleMembership({ hasTokenPlan: false, subscriptionType: 'mplan' })).toBe(true);
    expect(isEligibleMembership({ hasTokenPlan: false, subscriptionType: 'none' })).toBe(false);
    expect(isEligibleMembership({ hasTokenPlan: false, subscriptionType: 'unknown' })).toBe(false);
  });

  it('admits a subscribed account and issues one lookup per suggestion', async () => {
    const source = reader({ hasTokenPlan: true, subscriptionType: 'token_plan' });
    const gate = createPromptSuggestionEligibility(source);
    await expect(gate.check(new AbortController().signal)).resolves.toBeUndefined();
    expect(source.readMembershipFacts).toHaveBeenCalledTimes(1);
  });

  it('refuses without a session and never touches the backend', async () => {
    const source = reader({ hasTokenPlan: true, subscriptionType: 'token_plan' });
    const gate = createPromptSuggestionEligibility({
      ...source,
      readAuthSnapshot: () => ({ loginEpoch: 'epoch-1' }),
    });
    await expect(gate.check(new AbortController().signal)).resolves.toBe('not_signed_in');
    expect(source.readMembershipFacts).not.toHaveBeenCalled();
  });

  it('refuses a non-subscribed account and names an unnamed plan as unknown', async () => {
    const refused = createPromptSuggestionEligibility(
      reader({ hasTokenPlan: false, subscriptionType: 'none' }),
    );
    await expect(refused.check(new AbortController().signal)).resolves.toBe('no_plan');
    const unnamed = createPromptSuggestionEligibility(
      reader({ hasTokenPlan: false, subscriptionType: 'unknown' }),
    );
    await expect(unnamed.check(new AbortController().signal)).resolves.toBe('unknown');
  });

  it('fails closed on any transport, HTTP or protocol failure', async () => {
    const gate = createPromptSuggestionEligibility(
      reader(() => {
        throw new Error('Matrix backend HTTP 401');
      }),
    );
    await expect(gate.check(new AbortController().signal)).resolves.toBe('unknown');
  });

  it('fails closed when the membership read outlives its short budget', async () => {
    vi.useFakeTimers();
    try {
      const gate = createPromptSuggestionEligibility(
        reader(() => undefined as never),
      );
      const pending = gate.check(new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1_501);
      await expect(pending).resolves.toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses when the signed-in identity changes during the read', async () => {
    const rotated: AuthSnapshot = { accessToken: 'token-b', loginEpoch: 'epoch-1' };
    const sameTokenNewEpoch: AuthSnapshot = { accessToken: 'token-a', loginEpoch: 'epoch-2' };
    for (const after of [rotated, sameTokenNewEpoch]) {
      const gate = createPromptSuggestionEligibility(
        reader({ hasTokenPlan: true, subscriptionType: 'token_plan' }, [SIGNED_IN, after]),
      );
      await expect(gate.check(new AbortController().signal)).resolves.toBe('unknown');
    }
  });

  it('reports unknown once the caller aborts, so a cancel never buys a request', async () => {
    const controller = new AbortController();
    const gate = createPromptSuggestionEligibility({
      readAuthSnapshot: () => SIGNED_IN,
      readMembershipFacts: async () => {
        controller.abort();
        return { hasTokenPlan: true, subscriptionType: 'token_plan' };
      },
    });
    await expect(gate.check(controller.signal)).resolves.toBe('unknown');
  });
});
