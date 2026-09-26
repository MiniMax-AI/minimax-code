import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';

import type { CheckpointAttemptMetadata } from '../../agent-host/contracts.js';
import { readCompactionCompatibility } from '../compat.js';
import { CheckpointCandidateTooLargeError } from '../contracts.js';
import {
  compactContext,
  type CheckpointSession,
  type CompactContextInput,
} from './compact-context.js';

const TOOL_RESULT_REMOVED_TEXT = '[Tool result removed by context compaction.]';

const VALID_CHECKPOINT = `## Goal
complete compact v2

## Constraints & Preferences
same model only

## Completed Work
pure policy

## Current State
tests running

## Blockers
(none)

## Key Decisions
one checkpoint

## Pending User Asks
continue

## Critical Context & Relevant Files
compact-context.ts`;

const LIMITS = { providerInputLimit: 800, maxSerializedInputBytes: 20_000 };

describe('compactContext method policy', () => {
  it.each([undefined, '', ' \n\t '])(
    'runs trim admission before checkpoint for blank instructions %#',
    async (instructions) => {
      const h0 = threeRounds();
      const order: string[] = [];
      const input = policyInput(h0, {
        instructions,
        measurePair: vi.fn(async (pair) => {
          order.push(
            pair.afterMessages[0]?.role === 'compactionSummary' ? 'checkpoint-fit' : 'trim',
          );
          return pair.afterMessages[0]?.role === 'compactionSummary'
            ? footprint(1_000, 300)
            : footprint(1_000, 301);
        }),
        generate: vi.fn(async (request) => {
          order.push('checkpoint');
          expect(request.messages).toBe(h0);
          expect(request).not.toHaveProperty('instructions');
          return generation();
        }),
      });

      await expect(compactContext(input)).resolves.toMatchObject({
        method: 'llm_checkpoint',
        generationAttempts: 1,
      });
      expect(order).toEqual(['trim', 'checkpoint', 'checkpoint-fit']);
    },
  );

  it('skips direct trim measurement for nonempty instructions and checkpoints full H0 first', async () => {
    const h0 = threeRounds();
    const measurePair = vi.fn(async (pair) => {
      expect(pair.afterMessages[0]?.role).toBe('compactionSummary');
      return footprint(1_000, 300);
    });
    const generate = vi.fn<CheckpointSession['generate']>(async () => generation());

    await compactContext(
      policyInput(h0, { instructions: '  Preserve exact paths.  ', measurePair, generate }),
    );

    expect(generate).toHaveBeenCalledWith({
      messages: h0,
      instructions: 'Preserve exact paths.',
    });
    expect(measurePair).toHaveBeenCalledOnce();
  });

  it('commits an admitted complete tool trim without calling the checkpoint Provider', async () => {
    const h0 = threeRounds();
    const generate = vi.fn();
    const captureSubagents = vi.fn(async () => subagentSnapshot());
    const measurePair = vi.fn(async () => footprint(1_000, 300));

    const decision = await compactContext(
      policyInput(h0, { measurePair, generate, captureSubagents }),
    );

    expect(decision).toMatchObject({
      method: 'tool_trim',
      trimmedResultCount: 2,
      measurement: { after: { inputTokens: 300 } },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(captureSubagents).not.toHaveBeenCalled();
  });

  it('commits an admitted recoverable tool archive instead of legacy trim', async () => {
    const h0 = threeRounds();
    const archived = h0.map((message) =>
      message.role === 'toolResult'
        ? { ...message, content: [{ type: 'text' as const, text: '[archived receipt]' }] }
        : message,
    );
    const toolResultCompactionCandidate = {
      messages: archived,
      archivedResultCount: 2,
      actualSavingsBytes: 20_000,
    };
    const generate = vi.fn();

    await expect(
      compactContext({
        ...policyInput(h0, {
          measurePair: async () => footprint(1_000, 700),
          generate,
        }),
        toolResultCompactionCandidate,
        allowLegacyToolTrim: false,
      }),
    ).resolves.toMatchObject({
      method: 'tool_archive',
      archivedResultCount: 2,
      replacementMessages: archived,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('commits a thresholded destructive trim without the legacy 70% reduction gate', async () => {
    const h0 = threeRounds();
    const trimmed = h0.map((message) =>
      message.role === 'toolResult'
        ? { ...message, content: [{ type: 'text' as const, text: '[unavailable]' }] }
        : message,
    );
    const generate = vi.fn();

    await expect(
      compactContext({
        ...policyInput(h0, {
          measurePair: async () => footprint(1_000, 700),
          generate,
        }),
        toolResultCompactionCandidate: {
          messages: trimmed,
          trimmedResultCount: 2,
          actualSavingsBytes: 20_000,
        },
        allowLegacyToolTrim: false,
      }),
    ).resolves.toMatchObject({
      method: 'tool_trim',
      trimmedResultCount: 2,
      replacementMessages: trimmed,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends original complete H0 on the first checkpoint when direct trim is rejected', async () => {
    const h0 = threeRounds();
    const generate = vi.fn<CheckpointSession['generate']>(async () => generation());

    await compactContext(
      policyInput(h0, {
        measurePair: async (pair) =>
          pair.afterMessages[0]?.role === 'compactionSummary'
            ? footprint(1_000, 300)
            : footprint(1_000, 301),
        generate,
      }),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]?.messages).toBe(h0);
  });

  it('opens the checkpoint session lazily only after direct trim is rejected', async () => {
    const generate = vi.fn(async () => generation());
    const open = vi.fn(async () => ({ maxOutputTokens: 100, fits: () => true, generate }));

    await compactContext(
      policyInput(threeRounds(), {
        measurePair: async (pair) =>
          pair.afterMessages[0]?.role === 'compactionSummary'
            ? footprint(1_000, 300)
            : footprint(1_000, 301),
        open,
      }),
    );

    expect(open).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });

  it('preserves a footprint measurement failure instead of misclassifying History', async () => {
    const error = new Error('local estimator failed');

    await expect(
      compactContext(
        policyInput(threeRounds(), {
          measurePair: async () => {
            throw error;
          },
        }),
      ),
    ).rejects.toBe(error);
  });

  it('maps malformed ToolRound History before measurement or Provider work', async () => {
    const measurePair = vi.fn();
    const generate = vi.fn();
    const orphan: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'orphan',
      toolName: 'read',
      content: [{ type: 'text', text: 'orphan result' }],
      isError: false,
      timestamp: 1,
    };

    await expect(
      compactContext(policyInput([orphan], { measurePair, generate })),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY', stage: 'tool_trim' });
    expect(measurePair).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('compactContext overflow recovery', () => {
  it('uses the recoverable archive candidate as Htrim when direct archive does not fit', async () => {
    const h0 = threeRounds();
    const archived = h0.map((message) =>
      message.role === 'toolResult'
        ? { ...message, content: [{ type: 'text' as const, text: '[archived receipt]' }] }
        : message,
    );
    const generate = vi.fn<CheckpointSession['generate']>(async () => generation());
    const fits = vi
      .fn<CheckpointSession['fits']>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await compactContext({
      ...policyInput(h0, {
        measurePair: async (pair) =>
          pair.afterMessages[0]?.role === 'compactionSummary'
            ? footprint(1_000, 700)
            : footprint(1_000, 900),
        fits,
        generate,
      }),
      toolResultCompactionCandidate: {
        messages: archived,
        archivedResultCount: 2,
        actualSavingsBytes: 20_000,
      },
      allowLegacyToolTrim: false,
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]?.messages).toEqual(archived);
  });

  it('uses the destructive threshold candidate as Htrim when direct trim does not fit', async () => {
    const h0 = threeRounds();
    const trimmed = h0.map((message) =>
      message.role === 'toolResult'
        ? { ...message, content: [{ type: 'text' as const, text: '[unavailable]' }] }
        : message,
    );
    const generate = vi.fn<CheckpointSession['generate']>(async () => generation());
    const fits = vi
      .fn<CheckpointSession['fits']>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await compactContext({
      ...policyInput(h0, {
        measurePair: async (pair) =>
          pair.afterMessages[0]?.role === 'compactionSummary'
            ? footprint(1_000, 700)
            : footprint(1_000, 900),
        fits,
        generate,
      }),
      toolResultCompactionCandidate: {
        messages: trimmed,
        trimmedResultCount: 2,
        actualSavingsBytes: 20_000,
      },
      allowLegacyToolTrim: false,
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]?.messages).toEqual(trimmed);
  });

  it.each([
    ['h0', 1],
    ['htrim', 2],
    ['hall', 3],
    ['hvideo', 4],
    ['hmid', 5],
  ] as const)(
    'starts with the highest-fidelity fitting %s candidate',
    async (candidate, fitCall) => {
      const h0 = [
        userWithVideo('old query', 'secret-video-base64', 0),
        ...mixedRounds(),
        Object.assign(user('display wrapper', 11), { genuineUserQueryText: 'latest query' }),
      ];
      const attempts: CheckpointAttemptMetadata[] = [];
      const generate = vi.fn<CheckpointSession['generate']>(async () => generation());
      const fittedRequests: Array<Parameters<CheckpointSession['fits']>[0]> = [];
      let fitCalls = 0;
      const fits = vi.fn<CheckpointSession['fits']>((request) => {
        fittedRequests.push(request);
        fitCalls += 1;
        return fitCalls === fitCall;
      });
      const input = policyInput(h0, {
        measurePair: async (pair) =>
          pair.afterMessages[0]?.role === 'compactionSummary'
            ? footprint(1_000, 300)
            : footprint(1_000, 301),
        fits,
        generate,
      });

      const decision = await compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => attempts.push(metadata),
        },
      });

      expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 1 });
      expect(fits).toHaveBeenCalledTimes(fitCall);
      expect(generate).toHaveBeenCalledOnce();
      expect(generate.mock.calls[0]?.[0]?.messages).toBe(fittedRequests[fitCall - 1]?.messages);
      expect(attempts).toEqual([
        expect.objectContaining({ candidate, attemptNumber: 1, outcome: 'generated' }),
      ]);
    },
  );

  it('continues from a locally selected Htrim only after typed Provider overflow', async () => {
    const h0 = threeRounds();
    const originalH0 = structuredClone(h0);
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Htrim overflow'))
      .mockResolvedValueOnce(generation());
    const fits = vi
      .fn<CheckpointSession['fits']>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    const input = policyInput(h0, {
      measurePair: async (pair) =>
        pair.afterMessages[0]?.role === 'compactionSummary'
          ? footprint(1_000, 300)
          : footprint(1_000, 301),
      fits,
      generate,
    });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 2 });
    expect(fits).toHaveBeenCalledTimes(3);
    expect(generate).toHaveBeenCalledTimes(2);
    const htrim = generate.mock.calls[0]?.[0]?.messages;
    expect(htrim).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'toolResult',
          content: [{ type: 'text', text: TOOL_RESULT_REMOVED_TEXT }],
        }),
      ]),
    );
    expect(htrim).not.toBe(h0);
    expect(attempts).toEqual([
      expect.objectContaining({
        candidate: 'htrim',
        attemptNumber: 1,
        outcome: 'input_too_large',
      }),
      expect.objectContaining({ candidate: 'hall', attemptNumber: 2, outcome: 'generated' }),
    ]);
    expect(h0).toEqual(originalH0);
  });

  it('clears every settled tool result body after H0 and Htrim overflow', async () => {
    const h0 = mixedRounds();
    const originalH0 = structuredClone(h0);
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('full H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Htrim overflow'))
      .mockResolvedValueOnce(generation());

    const decision = await compactContext(
      policyInput(h0, {
        measurePair: async (pair) =>
          pair.afterMessages[0]?.role === 'compactionSummary'
            ? footprint(1_000, 300)
            : footprint(1_000, 301),
        generate,
      }),
    );

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 3 });
    expect(generate).toHaveBeenCalledTimes(3);
    const hall = generate.mock.calls[2]?.[0]?.messages;
    expect(hall?.filter((message) => message.role === 'toolResult')).toEqual(
      h0
        .filter((message) => message.role === 'toolResult')
        .map((message) => ({
          ...message,
          content: [{ type: 'text', text: TOOL_RESULT_REMOVED_TEXT }],
        })),
    );
    expect(h0).toEqual(originalH0);
  });
});

describe('compactContext historical video recovery', () => {
  it('numbers Hvideo second when Htrim and Hall are absent', async () => {
    const h0 = [
      userWithVideo('old query', 'secret-video-base64', 0),
      Object.assign(user('display wrapper', 1), { genuineUserQueryText: 'latest query' }),
    ];
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockResolvedValueOnce(generation());
    const input = policyInput(h0, { generate, fits: () => true });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 2 });
    expect(attempts.map(({ candidate, attemptNumber }) => `${candidate}:${attemptNumber}`)).toEqual(
      ['h0:1', 'hvideo:2'],
    );
  });

  it('uses one locally fitting Hvideo request after Hall overflow', async () => {
    const historicalVideo = userWithVideo('old query', 'secret-video-base64', 0);
    const latestQuery = Object.assign(user('display wrapper', 7), {
      genuineUserQueryText: 'latest query',
    });
    const h0 = [historicalVideo, ...threeRounds(), latestQuery];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Htrim overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hall overflow'))
      .mockResolvedValueOnce(generation());
    const fits = vi.fn((request: { readonly messages: readonly AgentMessage[] }) => {
      if (JSON.stringify(request.messages).includes('secret-video-base64')) return true;
      expect(request.messages).toHaveLength(h0.length);
      expect(request.messages[0]).toEqual({
        ...historicalVideo,
        content: [{ type: 'text', text: 'old query' }],
      });
      return true;
    });

    const decision = await compactContext(
      policyInput(h0, {
        measurePair: async () => footprint(1_000, 301),
        generate,
        fits,
      }),
    );

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 4 });
    expect(fits).toHaveBeenCalledTimes(4);
    expect(generate).toHaveBeenCalledTimes(4);
    expect(generate.mock.calls[3]?.[0]?.messages).toBe(fits.mock.calls[3]?.[0]?.messages);
    expect(generate.mock.calls[3]?.[0]?.messages.at(-1)).toBe(latestQuery);
  });

  it('skips an oversized Hvideo request and derives Hmid from its placeholder history', async () => {
    const h0 = [
      userWithVideo('old query', 'secret-video-base64', 0),
      ...threeRounds(),
      Object.assign(user('display wrapper', 7), { genuineUserQueryText: 'latest query' }),
    ];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Htrim overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hall overflow'))
      .mockResolvedValueOnce(generation());
    const fits = vi.fn((request: { readonly messages: readonly AgentMessage[] }) => {
      const serialized = JSON.stringify(request.messages);
      if (serialized.includes('secret-video-base64')) return true;
      expect(serialized).not.toContain('secret-video-base64');
      expect(serialized).not.toMatch(/"type":"(?:image|video)"/);
      return request.messages.length < h0.length;
    });
    const attempts: CheckpointAttemptMetadata[] = [];
    const input = policyInput(h0, {
      measurePair: async () => footprint(1_000, 301),
      generate,
      fits,
    });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 4 });
    expect(fits).toHaveBeenCalledTimes(5);
    expect(generate).toHaveBeenCalledTimes(4);
    expect(generate.mock.calls[3]?.[0]?.messages).toBe(fits.mock.calls[4]?.[0]?.messages);
    expect(attempts.map(({ candidate, attemptNumber }) => `${candidate}:${attemptNumber}`)).toEqual(
      ['h0:1', 'htrim:2', 'hall:3', 'hmid:4'],
    );
  });

  it('uses one Hmid request when a locally fitting Hvideo still overflows at the Provider', async () => {
    const h0 = [
      userWithVideo('old query', 'secret-video-base64', 0),
      ...threeRounds(),
      Object.assign(user('display wrapper', 7), { genuineUserQueryText: 'latest query' }),
    ];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Htrim overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hall overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hvideo overflow'))
      .mockResolvedValueOnce(generation());
    const fits = vi.fn(() => true);
    const attempts: CheckpointAttemptMetadata[] = [];
    const input = policyInput(h0, {
      measurePair: async () => footprint(1_000, 301),
      generate,
      fits,
    });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => {
          attempts.push(metadata);
          if (metadata.candidate === 'hall') throw new Error('diagnostics unavailable');
        },
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 5 });
    expect(generate).toHaveBeenCalledTimes(5);
    expect(fits).toHaveBeenCalledTimes(5);
    const hmid = generate.mock.calls[4]?.[0]?.messages ?? [];
    expect(hmid.length).toBeLessThan(h0.length);
    expect(JSON.stringify(hmid)).not.toContain('secret-video-base64');
    expect(JSON.stringify(hmid)).not.toMatch(/"type":"(?:image|video)"/);
    expect(
      attempts.map(({ candidate, attemptNumber, outcome }) => ({
        candidate,
        attemptNumber,
        outcome,
      })),
    ).toEqual([
      { candidate: 'h0', attemptNumber: 1, outcome: 'input_too_large' },
      { candidate: 'htrim', attemptNumber: 2, outcome: 'input_too_large' },
      { candidate: 'hall', attemptNumber: 3, outcome: 'input_too_large' },
      { candidate: 'hvideo', attemptNumber: 4, outcome: 'input_too_large' },
      { candidate: 'hmid', attemptNumber: 5, outcome: 'generated' },
    ]);
    expect(attempts.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(
      true,
    );
  });

  it('stops before Hvideo planning when the signal aborts after Hall overflow', async () => {
    const h0 = [
      userWithVideo('old query', 'secret-video-base64', 0),
      ...threeRounds(),
      Object.assign(user('display wrapper', 7), { genuineUserQueryText: 'latest query' }),
    ];
    const controller = new AbortController();
    let calls = 0;
    const generate = vi.fn<CheckpointSession['generate']>(async () => {
      calls += 1;
      if (calls === 3) controller.abort();
      throw new CheckpointCandidateTooLargeError('overflow');
    });
    const fits = vi.fn(() => true);

    await expect(
      compactContext(
        policyInput(h0, {
          signal: controller.signal,
          measurePair: async () => footprint(1_000, 301),
          generate,
          fits,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(fits).toHaveBeenCalledTimes(3);
  });
});

describe('compactContext output exhaustion', () => {
  it('advances the same ladder when a candidate exhausts its output budget', async () => {
    const h0 = [
      userWithVideo('old query', 'secret-video-base64', 0),
      ...threeRounds(),
      Object.assign(user('display wrapper', 7), { genuineUserQueryText: 'latest query' }),
    ];
    const exhausted = (label: string) =>
      new CheckpointCandidateTooLargeError(label, 'output_exhausted');
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(exhausted('H0 reasoning spent the budget'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Htrim overflow'))
      .mockRejectedValueOnce(exhausted('Hall reasoning spent the budget'))
      .mockRejectedValueOnce(exhausted('Hvideo reasoning spent the budget'))
      .mockResolvedValueOnce(generation());
    const attempts: CheckpointAttemptMetadata[] = [];
    const input = policyInput(h0, {
      measurePair: async () => footprint(1_000, 301),
      generate,
      fits: vi.fn(() => true),
    });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 5 });
    expect(generate.mock.calls.filter(([request]) => request.messages === h0)).toHaveLength(1);
    expect(
      attempts.map(({ candidate, attemptNumber, outcome }) => ({
        candidate,
        attemptNumber,
        outcome,
      })),
    ).toEqual([
      { candidate: 'h0', attemptNumber: 1, outcome: 'output_exhausted' },
      { candidate: 'htrim', attemptNumber: 2, outcome: 'input_too_large' },
      { candidate: 'hall', attemptNumber: 3, outcome: 'output_exhausted' },
      { candidate: 'hvideo', attemptNumber: 4, outcome: 'output_exhausted' },
      { candidate: 'hmid', attemptNumber: 5, outcome: 'generated' },
    ]);
  });

  it('fails with the stable input-too-large code after every candidate exhausts its output', async () => {
    const h0 = [
      userWithVideo('old query', 'secret-video-base64', 0),
      ...threeRounds(),
      Object.assign(user('display wrapper', 7), { genuineUserQueryText: 'latest query' }),
    ];
    const generate = vi.fn<CheckpointSession['generate']>(async () => {
      throw new CheckpointCandidateTooLargeError('reasoning spent the budget', 'output_exhausted');
    });
    const attempts: CheckpointAttemptMetadata[] = [];
    const input = policyInput(h0, {
      measurePair: async () => footprint(1_000, 301),
      generate,
      fits: vi.fn(() => true),
    });

    await expect(
      compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => attempts.push(metadata),
        },
      }),
    ).rejects.toMatchObject({ code: 'COMPACTION_INPUT_TOO_LARGE', stage: 'llm_checkpoint' });
    expect(attempts[0]?.candidate).toBe('h0');
    expect(attempts.at(-1)?.candidate).toBe('hmin');
    expect(attempts.map(({ candidate }) => candidate).filter((c) => c === 'h0')).toHaveLength(1);
    expect(attempts.map(({ attemptNumber }) => attemptNumber)).toEqual(
      attempts.map((_attempt, index) => index + 1),
    );
    expect(attempts.every(({ outcome }) => outcome === 'output_exhausted')).toBe(true);
  });
});

describe('compactContext final Hmin recovery', () => {
  it('uses one minimal genuine-query request after the only Hmid request overflows', async () => {
    const h0 = [
      checkpointRoot(0),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((text, index) =>
        assistantText(text, index + 1),
      ),
      Object.assign(user('display wrapper', 9), { genuineUserQueryText: 'latest query' }),
    ];
    const before = structuredClone(h0);
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('first Hmid overflow'))
      .mockResolvedValueOnce(generation());
    const fits = vi.fn<CheckpointSession['fits']>((request) => request.messages.length <= 8);
    const tokenUsage = {
      inputTokens: 28,
      outputTokens: 5,
      cacheReadTokens: 5,
      cacheWriteTokens: 11,
      totalTokens: 49,
      incomplete: false,
    } as const;
    const input = policyInput(h0, {
      fits,
      generate,
      checkpoint: {
        tokensBefore: 1_000,
        timestamp: 99,
        open: async () => ({ maxOutputTokens: 100, fits, generate }),
        getTokenUsage: () => tokenUsage,
      },
    });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({
      method: 'llm_checkpoint',
      hmidOverflowRecovered: true,
      tokenUsage,
    });
    expect(generate.mock.calls[0]?.[0].messages).toHaveLength(8);
    expect(generate.mock.calls[1]?.[0].messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'latest query' }],
        timestamp: 0,
      },
    ]);
    expect(attempts).toMatchObject([
      {
        candidate: 'hmid',
        outcome: 'input_too_large',
        inputMessageCount: 8,
      },
      {
        candidate: 'hmin',
        outcome: 'generated',
        inputMessageCount: 1,
      },
    ]);
    expect(h0).toEqual(before);
  });

  it('does not call Hmin when the minimal genuine query does not locally fit', async () => {
    const h0 = [
      checkpointRoot(0),
      assistantText('a', 1),
      assistantText('b', 2),
      Object.assign(user('display wrapper', 3), { genuineUserQueryText: 'latest query' }),
    ];
    const before = structuredClone(h0);
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi.fn<CheckpointSession['generate']>(async () => {
      throw new CheckpointCandidateTooLargeError('overflow');
    });
    const fits = vi.fn<CheckpointSession['fits']>((request) => {
      return !(
        request.messages.length === 1 &&
        request.messages[0]?.role === 'user' &&
        !Object.hasOwn(request.messages[0], 'genuineUserQueryText')
      );
    });
    const input = policyInput(h0, { fits, generate });

    await expect(
      compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => attempts.push(metadata),
        },
      }),
    ).rejects.toMatchObject({ code: 'COMPACTION_INPUT_TOO_LARGE' });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(attempts.map(({ candidate }) => candidate)).toEqual(['h0', 'hmid']);
    expect(h0).toEqual(before);
  });

  it('enters Hmin when no Hmid candidate exists despite genuine-query provenance', async () => {
    const h0 = [
      checkpointRoot(0),
      Object.assign(user('display wrapper', 1), { genuineUserQueryText: 'latest query' }),
    ];
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockResolvedValueOnce(generation());
    const input = policyInput(h0, { fits: () => true, generate });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({
      method: 'llm_checkpoint',
      hmidOverflowRecovered: true,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0]?.[0].messages).toBe(h0);
    expect(generate.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'latest query' }], timestamp: 0 },
    ]);
    expect(attempts.map(({ candidate }) => candidate)).toEqual(['h0', 'hmin']);
  });

  it.each([
    ['typed overflow', new CheckpointCandidateTooLargeError('Hmin overflow'), 'typed'],
    ['network error', new Error('network unavailable'), 'identity'],
  ] as const)('stops after one Hmin %s', async (_case, hminError, expected) => {
    const h0 = [
      checkpointRoot(0),
      assistantText('a', 1),
      assistantText('b', 2),
      Object.assign(user('display wrapper', 3), { genuineUserQueryText: 'latest query' }),
    ];
    const before = structuredClone(h0);
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hmid overflow'))
      .mockRejectedValueOnce(hminError);

    const pending = compactContext(policyInput(h0, { fits: () => true, generate }));
    if (expected === 'identity') await expect(pending).rejects.toBe(hminError);
    else await expect(pending).rejects.toMatchObject({ code: 'COMPACTION_INPUT_TOO_LARGE' });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(h0).toEqual(before);
  });

  it('does not retry after Hmin returns an invalid checkpoint', async () => {
    const h0 = [
      checkpointRoot(0),
      assistantText('a', 1),
      assistantText('b', 2),
      Object.assign(user('display wrapper', 3), { genuineUserQueryText: 'latest query' }),
    ];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hmid overflow'))
      .mockResolvedValueOnce(generation({ text: ' ' }));

    await expect(
      compactContext(policyInput(h0, { fits: () => true, generate })),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('does not retry or mutate H0 when a successful Hmin fails post-admission', async () => {
    const h0 = [
      checkpointRoot(0),
      assistantText('a', 1),
      assistantText('b', 2),
      Object.assign(user('display wrapper', 3), { genuineUserQueryText: 'latest query' }),
    ];
    const before = structuredClone(h0);
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hmid overflow'))
      .mockResolvedValueOnce(generation());

    await expect(
      compactContext(
        policyInput(h0, {
          fits: () => true,
          generate,
          measurePair: async () => footprint(1_000, 801),
        }),
      ),
    ).rejects.toMatchObject({ code: 'POST_ADMISSION_FAILED', stage: 'post_admission' });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(h0).toEqual(before);
  });
});

describe('compactContext local-rejection Hmin recovery', () => {
  it('recovers through Hmin without Provider attempts when local fits rejects every larger candidate', async () => {
    const h0 = [
      checkpointRoot(0),
      ...threeRounds(),
      Object.assign(user('display wrapper', 9), { genuineUserQueryText: 'latest query' }),
    ];
    const before = structuredClone(h0);
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi.fn<CheckpointSession['generate']>(async () => generation());
    const fits = vi.fn<CheckpointSession['fits']>(
      (request) =>
        request.messages.length === 1 &&
        request.messages[0]?.role === 'user' &&
        !Object.hasOwn(request.messages[0], 'genuineUserQueryText'),
    );
    const input = policyInput(h0, {
      fits,
      generate,
      measurePair: async () => footprint(1_000, 301),
    });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint' });
    expect(decision).not.toHaveProperty('hmidOverflowRecovered');
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'latest query' }], timestamp: 0 },
    ]);
    expect(attempts).toMatchObject([
      { candidate: 'hmin', outcome: 'generated', inputMessageCount: 1 },
    ]);
    expect(h0).toEqual(before);
  });

  it('attaches content-free sizing diagnostics when even Hmin cannot be admitted', async () => {
    const h0 = [
      checkpointRoot(0),
      ...threeRounds(),
      Object.assign(user('display wrapper', 9), { genuineUserQueryText: 'latest query' }),
    ];
    const generate = vi.fn<CheckpointSession['generate']>(async () => generation());
    const measure = vi.fn<NonNullable<CheckpointSession['measure']>>(() => ({
      inputTokens: 123_456,
      serializedBytes: 654_321,
    }));

    await expect(
      compactContext(
        policyInput(h0, {
          measurePair: async () => footprint(1_000, 301),
          open: async () => ({
            maxOutputTokens: 100,
            fits: () => false,
            measure,
            generate,
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'COMPACTION_INPUT_TOO_LARGE',
      diagnostics: {
        historyMessageCount: h0.length,
        protectedMessageCount: 2,
        protectedInputTokens: 123_456,
        protectedSerializedBytes: 654_321,
        providerInputLimit: 800,
        maxSerializedInputBytes: 20_000,
        hminAvailable: true,
      },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(measure.mock.calls[0]?.[0]?.messages.map((message) => message.role)).toEqual([
      'compactionSummary',
      'user',
    ]);
  });
});

describe('compactContext final Hmin boundaries', () => {
  it('skips locally oversized Hmid candidates without consuming Provider attempts', async () => {
    const h0 = [
      checkpointRoot(0),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((text, index) =>
        assistantText(text, index + 1),
      ),
      user('trigger', 9),
    ];
    const attempts: CheckpointAttemptMetadata[] = [];
    const fits = vi.fn<CheckpointSession['fits']>((request) => request.messages.length <= 3);
    const generate = vi.fn<CheckpointSession['generate']>(async () => generation());
    const input = policyInput(h0, { fits, generate });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint' });
    expect(fits.mock.calls.map(([request]) => request.messages.length)).toEqual([
      10, 9, 8, 7, 6, 5, 4, 3,
    ]);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]?.messages).toHaveLength(3);
    expect(attempts).toEqual([
      expect.objectContaining({ candidate: 'hmid', attemptNumber: 1, outcome: 'generated' }),
    ]);
  });

  it.each([
    ['auth', Object.assign(new Error('auth failed'), { status: 401 })],
    ['network', Object.assign(new Error('network unavailable'), { code: 'ENETUNREACH' })],
    ['timeout', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })],
    ['cancel', new DOMException('cancelled', 'AbortError')],
    ['rate limit', Object.assign(new Error('rate limited'), { status: 429 })],
    ['server', Object.assign(new Error('server failed'), { status: 500 })],
    ['unknown', { kind: 'unknown-provider-failure' }],
  ])('does not advance past a non-overflow Hmid %s error', async (_case, error) => {
    const h0 = [
      checkpointRoot(0),
      assistantText('a', 1),
      assistantText('b', 2),
      assistantText('c', 3),
      user('trigger', 4),
    ];
    const generate = vi.fn<CheckpointSession['generate']>(async () => {
      throw error;
    });

    await expect(
      compactContext(
        policyInput(h0, {
          fits: (request) => request.messages !== h0,
          generate,
        }),
      ),
    ).rejects.toBe(error);
    expect(generate).toHaveBeenCalledOnce();
  });

  it('does not enter Hmin after the only Hmid request returns an invalid checkpoint', async () => {
    const h0 = [
      checkpointRoot(0),
      assistantText('a', 1),
      Object.assign(user('display wrapper', 2), { genuineUserQueryText: 'latest query' }),
    ];
    const generate = vi.fn<CheckpointSession['generate']>(async () => generation({ text: ' ' }));

    await expect(
      compactContext(
        policyInput(h0, {
          fits: (request) => request.messages !== h0,
          generate,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT', stage: 'llm_checkpoint' });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('stops before Hmin when aborted between attempts', async () => {
    const controller = new AbortController();
    const h0 = [
      checkpointRoot(0),
      assistantText('a', 1),
      assistantText('b', 2),
      assistantText('c', 3),
      user('trigger', 4),
    ];
    const before = structuredClone(h0);
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi.fn<CheckpointSession['generate']>(async () => {
      throw new CheckpointCandidateTooLargeError('Hmid overflow');
    });
    const input = policyInput(h0, {
      signal: controller.signal,
      fits: (request) => request.messages !== h0,
      generate,
    });

    await expect(
      compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => {
            attempts.push(metadata);
            controller.abort();
          },
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(generate).toHaveBeenCalledOnce();
    expect(attempts).toEqual([
      expect.objectContaining({ candidate: 'hmid', attemptNumber: 1, outcome: 'input_too_large' }),
    ]);
    expect(h0).toEqual(before);
  });
});

describe('compactContext middle deletion compatibility', () => {
  it('uses the shortest locally fitting prefix without splitting a parallel ToolRound', async () => {
    const h0: AgentMessage[] = [
      checkpointRoot(0),
      assistantText('left', 1),
      ...parallelToolRound(2),
      assistantText('middle', 5),
      Object.assign(user('display wrapper', 6), { genuineUserQueryText: 'latest query' }),
      assistantText('right', 7),
      internalControl(8),
    ];
    const originalH0 = structuredClone(h0);
    const measuredCandidates: (readonly AgentMessage[])[] = [];
    const fits = vi.fn((request: { readonly messages: readonly AgentMessage[] }) => {
      measuredCandidates.push(request.messages);
      return !request.messages.some(
        (message) => message.role === 'assistant' && readAssistantText(message) === 'left',
      );
    });
    const generate = vi.fn<CheckpointSession['generate']>().mockResolvedValueOnce(generation());
    const attempts: CheckpointAttemptMetadata[] = [];
    const input = policyInput(h0, {
      measurePair: async () => footprint(1_000, 300),
      fits,
      generate,
    });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 1 });
    expect(fits).toHaveBeenCalledTimes(4);
    expect(measuredCandidates[0]).toBe(h0);
    expect(measuredCandidates[1]?.some((message) => message.role === 'toolResult')).toBe(true);
    expect(measuredCandidates[2]?.some((message) => readAssistantText(message) === 'left')).toBe(
      true,
    );
    expect(measuredCandidates[3]?.some((message) => readAssistantText(message) === 'left')).toBe(
      false,
    );
    const hmid = generate.mock.calls[0]?.[0]?.messages ?? [];
    expect(hmid).toBe(measuredCandidates[3]);
    expect(hmid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'compactionSummary' }),
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'middle' }] }),
        expect.objectContaining({ role: 'user', genuineUserQueryText: 'latest query' }),
        internalControl(8),
      ]),
    );
    expect(attempts.map(({ candidate, attemptNumber }) => `${candidate}:${attemptNumber}`)).toEqual(
      ['hmid:1'],
    );
    expect(h0).toEqual(originalH0);
  });

  it('keeps custom instructions through H0, Htrim, Hall, and the single Hmid request', async () => {
    const h0 = mixedRounds();
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Htrim overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hall overflow'))
      .mockResolvedValueOnce(generation());

    const decision = await compactContext(
      policyInput(h0, {
        instructions: ' Preserve exact paths. ',
        fits: () => true,
        generate,
      }),
    );

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 4 });
    expect(generate).toHaveBeenCalledTimes(4);
    expect(generate.mock.calls.map(([request]) => request.instructions)).toEqual(
      Array.from({ length: 4 }, () => 'Preserve exact paths.'),
    );
    expect(generate.mock.calls[0]?.[0]?.messages).toBe(h0);
  });
});

describe('compactContext local selection failure', () => {
  it('fails before Provider generation when no checkpoint candidate locally fits', async () => {
    const h0 = [
      userWithVideo('old query', 'secret-video-base64', 0),
      ...mixedRounds(),
      Object.assign(user('display wrapper', 11), { genuineUserQueryText: 'latest query' }),
    ];
    const before = structuredClone(h0);
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi.fn<CheckpointSession['generate']>();
    const input = policyInput(h0, {
      measurePair: async () => footprint(1_000, 301),
      fits: () => false,
      generate,
    });

    await expect(
      compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => attempts.push(metadata),
        },
      }),
    ).rejects.toMatchObject({
      code: 'COMPACTION_INPUT_TOO_LARGE',
      stage: 'llm_checkpoint',
    });
    expect(generate).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);
    expect(h0).toEqual(before);
  });
});

describe('compactContext overflow failure boundaries', () => {
  it('returns typed input-too-large after exhausting the protected skeleton', async () => {
    const root = checkpointRoot(0);
    const trigger = user('trigger', 5);
    const h0 = [
      root,
      ...Array.from({ length: 4 }, (_, index) => assistantText(`work-${index}`, index + 1)),
      trigger,
    ];
    const before = structuredClone(h0);
    const generate = vi.fn<CheckpointSession['generate']>(async () => {
      throw new CheckpointCandidateTooLargeError('overflow');
    });

    await expect(
      compactContext(policyInput(h0, { fits: () => true, generate })),
    ).rejects.toMatchObject({
      code: 'COMPACTION_INPUT_TOO_LARGE',
      stage: 'llm_checkpoint',
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls.at(-1)?.[0].messages).toHaveLength(h0.length - 1);
    expect(generate.mock.calls.at(-1)?.[0].messages).toEqual(
      expect.arrayContaining([root, trigger]),
    );
    expect(h0).toEqual(before);
  });

  it('builds the committed continuation appendix from H0 after Hmid deletes the Todo round', async () => {
    const todo = [{ content: 'Preserve this Todo', status: 'pending', priority: 'high' }];
    const h0: AgentMessage[] = [
      checkpointRoot(0),
      assistantToolNamed('todo', 'todowrite', 1),
      Object.assign(toolResultNamed('todo', 'todowrite', 2), { details: { todos: todo } }),
      assistantText('middle work', 3),
      Object.assign(user('display wrapper', 4), { genuineUserQueryText: 'latest query' }),
    ];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hall overflow'))
      .mockResolvedValueOnce(generation());

    const decision = await compactContext(policyInput(h0, { fits: () => true, generate }));

    expect(generate.mock.calls[2]?.[0]?.messages).not.toContain(h0[1]);
    expect(readCompactionCompatibility(decision.replacementMessages[0])).toMatchObject({
      recentUserQueries: [{ text: 'latest query', timestampMs: 4 }],
      todoState: todo,
    });
  });

  it('uses attachment-free Hvideo then fails typed for an attachment-only current query', async () => {
    const currentQuery = {
      role: 'user',
      content: [
        { type: 'text', text: '' },
        { type: 'video', data: 'current-query-video', mimeType: 'video/mp4' },
      ],
      canonicalTextRange: { startOffset: 0, endOffset: 0 },
      timestamp: 1,
    } as unknown as AgentMessage;
    const h0 = [currentQuery];
    const before = structuredClone(h0);
    const generate = vi.fn<CheckpointSession['generate']>(async () => {
      throw new CheckpointCandidateTooLargeError('overflow');
    });
    const fits = vi.fn(() => true);

    await expect(compactContext(policyInput(h0, { generate, fits }))).rejects.toMatchObject({
      code: 'COMPACTION_INPUT_TOO_LARGE',
      stage: 'llm_checkpoint',
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0]?.[0]?.messages).toBe(h0);
    expect(generate.mock.calls[1]?.[0]?.messages).toEqual([
      {
        ...currentQuery,
        content: [{ type: 'text', text: '' }],
      },
    ]);
    expect(fits).toHaveBeenCalledTimes(2);
    expect(h0).toEqual(before);
  });

  it('preserves a non-overflow Hvideo error without constructing Hmid', async () => {
    const h0 = [
      userWithVideo('old query', 'secret-video-base64', 0),
      ...threeRounds(),
      Object.assign(user('display wrapper', 7), { genuineUserQueryText: 'latest query' }),
    ];
    const error = new Error('auth failed');
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('H0 overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Htrim overflow'))
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('Hall overflow'))
      .mockRejectedValueOnce(error);
    const fits = vi.fn(() => true);
    const attempts: CheckpointAttemptMetadata[] = [];
    const input = policyInput(h0, {
      measurePair: async () => footprint(1_000, 301),
      generate,
      fits,
    });

    await expect(
      compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => attempts.push(metadata),
        },
      }),
    ).rejects.toBe(error);
    expect(generate).toHaveBeenCalledTimes(4);
    expect(fits).toHaveBeenCalledTimes(4);
    expect(attempts.at(-1)).toMatchObject({
      candidate: 'hvideo',
      attemptNumber: 4,
      outcome: 'failed',
    });
  });

  it('reports an in-flight Provider abort once', async () => {
    const controller = new AbortController();
    const attempts: CheckpointAttemptMetadata[] = [];
    const input = policyInput([user('current query', 1)], {
      signal: controller.signal,
      generate: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
    });

    await expect(
      compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => attempts.push(metadata),
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ candidate: 'h0', attemptNumber: 1, outcome: 'aborted' });
  });

  it.each([1, 2, 3, 4])(
    'preserves a non-overflow error at logical call %i without advancing again',
    async (failureCall) => {
      const error = new Error('auth failed');
      let calls = 0;
      const generate = vi.fn(async () => {
        calls += 1;
        if (calls < failureCall) throw new CheckpointCandidateTooLargeError('overflow');
        throw error;
      });
      const fits = vi.fn(() => true);

      await expect(
        compactContext(
          policyInput(threeRounds(), {
            measurePair: async () => footprint(1_000, 301),
            generate,
            fits,
          }),
        ),
      ).rejects.toBe(error);
      expect(generate).toHaveBeenCalledTimes(failureCall);
      expect(fits).toHaveBeenCalledTimes(failureCall);
    },
  );
});

describe('compactContext checkpoint admission', () => {
  it('omits an empty subagent snapshot from the committed appendix', async () => {
    const captureSubagents = vi.fn(async () => ({
      ...subagentSnapshot(),
      total: 0,
      counts: { ...subagentSnapshot().counts, running: 0 },
      items: [],
    }));

    const decision = await compactContext(
      policyInput([user('no tool rounds', 1)], { captureSubagents }),
    );

    expect({
      captureCalls: captureSubagents.mock.calls.length,
      subagents: readCompactionCompatibility(decision.replacementMessages[0])?.subagents,
    }).toEqual({ captureCalls: 1, subagents: undefined });
  });

  it('keeps checkpoint admission fail-open when subagent capture throws', async () => {
    const onSubagentCaptureFailure = vi.fn();
    const decision = await compactContext(
      policyInput([user('no tool rounds', 1)], {
        captureSubagents: async () => {
          throw new Error('capture failed');
        },
        onSubagentCaptureFailure,
      }),
    );

    expect({
      method: decision.method,
      diagnostics: onSubagentCaptureFailure.mock.calls.length,
      subagents: readCompactionCompatibility(decision.replacementMessages[0])?.subagents,
    }).toEqual({ method: 'llm_checkpoint', diagnostics: 1, subagents: undefined });
  });

  it('captures subagents once after generation retry and drops only that section on overflow', async () => {
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('full H0 overflow'))
      .mockResolvedValueOnce(generation());
    const captureSubagents = vi.fn(async () => subagentSnapshot());
    const measurePair = vi.fn(async (pair) => {
      const hasSubagents = Boolean(readCompactionCompatibility(pair.afterMessages[0])?.subagents);
      return footprint(1_000, hasSubagents ? 801 : 300);
    });

    const decision = await compactContext(
      policyInput(threeRounds(), {
        instructions: 'preserve decisions',
        generate,
        captureSubagents,
        measurePair,
      }),
    );

    expect({
      method: decision.method,
      generationCalls: generate.mock.calls.length,
      captureCalls: captureSubagents.mock.calls.length,
      measurementCalls: measurePair.mock.calls.length,
      committedSubagents: readCompactionCompatibility(decision.replacementMessages[0])?.subagents,
      afterTokens: decision.measurement.after.inputTokens,
    }).toEqual({
      method: 'llm_checkpoint',
      generationCalls: 2,
      captureCalls: 1,
      measurementCalls: 2,
      committedSubagents: undefined,
      afterTokens: 300,
    });
  });

  it('uses a non-empty length-limited checkpoint as the replacement without another generation', async () => {
    const h0 = [user('no tool rounds', 1)];
    const text = '## Goal\nContinue the task.\n\n## Current State\nWork is';
    const generate = vi.fn<CheckpointSession['generate']>(async () =>
      generation({ text, stopReason: 'length', outputTokens: 100 }),
    );

    const decision = await compactContext(policyInput(h0, { generate }));

    expect(decision).toMatchObject({
      method: 'llm_checkpoint',
      summary: text,
      schemaStatus: 'soft_fallback',
      generationAttempts: 1,
      replacementMessages: [{ role: 'compactionSummary', summary: expect.stringContaining(text) }],
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each([
    ['tool-use response', generation({ stopReason: 'toolUse' })],
    ['length with empty text', generation({ stopReason: 'length', text: '' })],
  ])('rejects %s before building or measuring a replacement', async (_case, output) => {
    const h0 = [user('no tool rounds', 1)];
    const measurePair = vi.fn();
    const captureSubagents = vi.fn(async () => subagentSnapshot());

    await expect(
      compactContext(
        policyInput(h0, {
          measurePair,
          captureSubagents,
          generate: async () => output,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT', stage: 'llm_checkpoint' });
    expect(measurePair).not.toHaveBeenCalled();
    expect(captureSubagents).not.toHaveBeenCalled();
    expect(h0).toEqual([user('no tool rounds', 1)]);
  });

  it('accepts a checkpoint that saves only 20% when it fits both final gates', async () => {
    const decision = await compactContext(
      policyInput([user('no tool rounds', 1)], {
        measurePair: async () => footprint(1_000, 800),
      }),
    );

    expect(decision).toMatchObject({
      method: 'llm_checkpoint',
      measurement: { before: { inputTokens: 1_000 }, after: { inputTokens: 800 } },
    });
  });

  it.each([
    ['token fit', { inputTokens: 801, serializedBytes: 10_000 }],
    ['serialized-byte fit', { inputTokens: 300, serializedBytes: 20_001 }],
  ])('fails typed post-admission on %s without returning a decision', async (_case, after) => {
    await expect(
      compactContext(
        policyInput([user('no tool rounds', 1)], {
          measurePair: async () => ({ before: footprintSide(1_000, 30_000), after }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'POST_ADMISSION_FAILED', stage: 'post_admission' });
  });

  it.each([
    ['equal bytes', 30_000, true],
    ['smaller bytes', 29_999, true],
    ['larger bytes', 30_001, false],
  ] as const)(
    'without an explicit byte cap treats a checkpoint with %s as admitted=%s',
    async (_label, afterBytes, admitted) => {
      const pending = compactContext(
        policyInput([user('no tool rounds', 1)], {
          limits: { providerInputLimit: 800 },
          measurePair: async () => ({
            before: footprintSide(1_000, 30_000),
            after: footprintSide(300, afterBytes),
          }),
        }),
      );

      if (admitted) {
        await expect(pending).resolves.toMatchObject({ method: 'llm_checkpoint' });
      } else {
        await expect(pending).rejects.toMatchObject({
          code: 'POST_ADMISSION_FAILED',
          stage: 'post_admission',
        });
      }
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid explicit byte cap %s before policy work',
    async (maxSerializedInputBytes) => {
      const measurePair = vi.fn();
      const generate = vi.fn();

      await expect(
        compactContext(
          policyInput([user('no tool rounds', 1)], {
            limits: { providerInputLimit: 800, maxSerializedInputBytes },
            measurePair,
            generate,
          }),
        ),
      ).rejects.toThrow(TypeError);
      expect(measurePair).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    },
  );
});

describe('compactContext Provider generation outcomes', () => {
  it('classifies a zero-output aborted checkpoint attempt as aborted', async () => {
    const attempts: CheckpointAttemptMetadata[] = [];
    const input = policyInput([user('no tool rounds', 1)], {
      generate: async () =>
        generation({
          text: '',
          stopReason: 'aborted',
          outputTokens: 0,
          responseContentKinds: [],
        }),
    });

    await expect(
      compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => attempts.push(metadata),
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT', stage: 'llm_checkpoint' });
    expect(attempts).toEqual([
      expect.objectContaining({ candidate: 'h0', attemptNumber: 1, outcome: 'aborted' }),
    ]);
  });

  it('retries a Provider-failed checkpoint once and uses the second generation', async () => {
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockResolvedValueOnce(
        generation({ text: '', stopReason: 'error', outputTokens: 0, responseContentKinds: [] }),
      )
      .mockResolvedValueOnce(generation());
    const input = policyInput([user('no tool rounds', 1)], { generate });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([
      expect.objectContaining({ candidate: 'h0', attemptNumber: 1, outcome: 'failed' }),
      expect.objectContaining({ candidate: 'h0', attemptNumber: 2, outcome: 'generated' }),
    ]);
  });

  it('retries the failing candidate in place without re-sending earlier overflowed candidates', async () => {
    const h0 = mixedRounds();
    const attempts: CheckpointAttemptMetadata[] = [];
    const generate = vi
      .fn<CheckpointSession['generate']>()
      .mockRejectedValueOnce(new CheckpointCandidateTooLargeError('full H0 overflow'))
      .mockResolvedValueOnce(
        generation({ text: '', stopReason: 'error', outputTokens: 0, responseContentKinds: [] }),
      )
      .mockResolvedValueOnce(generation());
    const input = policyInput(h0, {
      measurePair: async (pair) =>
        pair.afterMessages[0]?.role === 'compactionSummary'
          ? footprint(1_000, 300)
          : footprint(1_000, 301),
      generate,
    });

    const decision = await compactContext({
      ...input,
      checkpoint: {
        ...input.checkpoint,
        onAttemptSettled: (metadata) => attempts.push(metadata),
      },
    });

    expect(decision).toMatchObject({ method: 'llm_checkpoint', generationAttempts: 3 });
    expect(generate).toHaveBeenCalledTimes(3);
    // The oversized H0 request is never re-sent; the retry reuses the failing candidate.
    expect(generate.mock.calls[1]?.[0]?.messages).toBe(generate.mock.calls[2]?.[0]?.messages);
    expect(attempts).toEqual([
      expect.objectContaining({ candidate: 'h0', attemptNumber: 1, outcome: 'input_too_large' }),
      expect.objectContaining({ candidate: 'htrim', attemptNumber: 2, outcome: 'failed' }),
      expect.objectContaining({ candidate: 'htrim', attemptNumber: 3, outcome: 'generated' }),
    ]);
  });

  it('gives up with CHECKPOINT_PROVIDER_FAILED after one Provider retry', async () => {
    const attempts: CheckpointAttemptMetadata[] = [];
    const measurePair = vi.fn();
    const generate = vi.fn<CheckpointSession['generate']>(async () =>
      generation({ text: '', stopReason: 'error', outputTokens: 0, responseContentKinds: [] }),
    );
    const input = policyInput([user('no tool rounds', 1)], { generate, measurePair });

    await expect(
      compactContext({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          onAttemptSettled: (metadata) => attempts.push(metadata),
        },
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_PROVIDER_FAILED', stage: 'llm_checkpoint' });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(measurePair).not.toHaveBeenCalled();
    expect(attempts).toEqual([
      expect.objectContaining({ candidate: 'h0', attemptNumber: 1, outcome: 'failed' }),
      expect.objectContaining({ candidate: 'h0', attemptNumber: 2, outcome: 'failed' }),
    ]);
  });
});

describe('compactContext final admission sizing and bypass', () => {
  it('attaches content-free before/after sizing to POST_ADMISSION_FAILED', async () => {
    await expect(
      compactContext(
        policyInput([user('no tool rounds', 1)], {
          measurePair: async () => ({
            before: footprintSide(1_000, 30_000),
            after: footprintSide(801, 10_000),
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'POST_ADMISSION_FAILED',
      diagnostics: {
        historyMessageCount: 1,
        providerInputLimit: 800,
        maxSerializedInputBytes: 20_000,
        beforeInputTokens: 1_000,
        beforeSerializedBytes: 30_000,
        afterInputTokens: 801,
        afterSerializedBytes: 10_000,
      },
    });
  });

  it('commits a checkpoint that misses the final gates when final admission is bypassed', async () => {
    const decision = await compactContext(
      policyInput([user('no tool rounds', 1)], {
        finalAdmission: 'bypass',
        measurePair: async () => ({
          before: footprintSide(1_000, 30_000),
          after: footprintSide(801, 10_000),
        }),
      }),
    );

    expect(decision).toMatchObject({
      method: 'llm_checkpoint',
      measurement: { after: { inputTokens: 801 } },
    });
  });
});

function policyInput(
  h0: readonly AgentMessage[],
  overrides: Partial<CompactContextInput> & {
    readonly generate?: CheckpointSession['generate'];
    readonly fits?: CheckpointSession['fits'];
    readonly open?: () => Promise<CheckpointSession>;
  } = {},
): CompactContextInput {
  const { generate, fits, open, ...rest } = overrides;
  return {
    history: h0,
    limits: LIMITS,
    measurePair: async () => footprint(1_000, 300),
    checkpoint: {
      tokensBefore: 1_000,
      timestamp: 99,
      open:
        open ??
        (async () => ({
          maxOutputTokens: 100,
          fits: fits ?? (() => true),
          generate: generate ?? (async () => generation()),
        })),
    },
    ...rest,
  };
}

function generation(overrides: Partial<Awaited<ReturnType<CheckpointSession['generate']>>> = {}) {
  return {
    text: VALID_CHECKPOINT,
    stopReason: 'stop' as const,
    outputTokens: 80,
    responseContentKinds: ['text'] as const,
    ...overrides,
  };
}

function footprint(beforeTokens: number, afterTokens: number) {
  return {
    before: footprintSide(beforeTokens, 30_000),
    after: footprintSide(afterTokens, 10_000),
  };
}

function footprintSide(inputTokens: number, serializedBytes: number) {
  return { inputTokens, serializedBytes };
}

function threeRounds(): AgentMessage[] {
  return Array.from({ length: 3 }, (_, index) => {
    const id = `round-${index + 1}`;
    const timestamp = index * 2 + 1;
    return [assistantTool(id, timestamp), toolResult(id, timestamp + 1)];
  }).flat();
}

function mixedRounds(): AgentMessage[] {
  return [
    ...toolRound('native', 'read', 1),
    ...toolRound('mcp', 'mcp__filesystem__read', 3),
    ...toolRound('todo', 'todowrite', 5),
    ...toolRound('custom', 'custom_export', 7),
    ...toolRound('protected', 'read', 9),
  ];
}

function toolRound(id: string, name: string, timestamp: number): AgentMessage[] {
  return [assistantToolNamed(id, name, timestamp), toolResultNamed(id, name, timestamp + 1)];
}

function parallelToolRound(timestamp: number): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'parallel-a', name: 'custom_a', arguments: {} },
        { type: 'toolCall', id: 'parallel-b', name: 'custom_b', arguments: {} },
      ],
      stopReason: 'toolUse',
      timestamp,
    } as unknown as AgentMessage,
    toolResultNamed('parallel-a', 'custom_a', timestamp + 1),
    toolResultNamed('parallel-b', 'custom_b', timestamp + 2),
  ];
}

function assistantTool(id: string, timestamp: number): AgentMessage {
  return assistantToolNamed(id, 'read', timestamp);
}

function assistantToolNamed(id: string, name: string, timestamp: number): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: { path: `/${id}` } }],
    stopReason: 'toolUse',
    timestamp,
  } as unknown as AgentMessage;
}

function toolResult(id: string, timestamp: number): AgentMessage {
  return toolResultNamed(id, 'read', timestamp);
}

function toolResultNamed(id: string, name: string, timestamp: number): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text: `${id} output` }],
    isError: false,
    timestamp,
  };
}

function user(text: string, timestamp: number): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}

function subagentSnapshot() {
  return {
    capturedAtMs: 90,
    total: 1,
    counts: {
      queued: 0,
      running: 1,
      stopping: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
      lost: 0,
    },
    omitted: 0,
    textFieldsAreUntrusted: true as const,
    detailsHint:
      'Call task_query for the live task list, then task_output(task_id) for progress or results.' as const,
    items: [
      {
        taskId: 'bg-running',
        status: 'running' as const,
        updatedAtMs: 89,
        delivered: false,
        description: 'work in progress',
      },
    ],
  };
}

function userWithVideo(text: string, data: string, timestamp: number): AgentMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', data, mimeType: 'video/mp4' },
    ],
    timestamp,
  };
}

function assistantText(text: string, timestamp: number): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp,
  } as unknown as AgentMessage;
}

function readAssistantText(message: AgentMessage): string | undefined {
  if (message.role !== 'assistant') return undefined;
  const only = message.content.length === 1 ? message.content[0] : undefined;
  return only?.type === 'text' ? only.text : undefined;
}

function checkpointRoot(timestamp: number): AgentMessage {
  return { role: 'compactionSummary', summary: 'prior checkpoint', tokensBefore: 1, timestamp };
}

function internalControl(timestamp: number): AgentMessage {
  return user(
    '<archon_internal_context source="goal">\ncontinue\n</archon_internal_context>',
    timestamp,
  );
}
