import { describe, expect, it, vi } from 'vitest';

import type { SessionRecord } from '../repo/contract.js';
import {
  refreshToolCallModeAfterCompaction,
  type SessionToolCallModePolicy,
  type SessionToolCallModeRefresh,
} from './tool-call-mode.js';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'session-1',
    agentName: 'mavis',
    workspaceDir: '/workspace',
    runtime: 'pi-agent',
    sessionType: 'branch',
    sessionKind: 'conversation',
    archived: false,
    parentSessionId: null,
    status: 'idle',
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function harness(
  current: SessionRecord | undefined,
  mode: 'native' | 'ptc',
  options: { readonly updateError?: Error } = {},
) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const policy: SessionToolCallModePolicy = { current: () => mode, logger };
  const update = vi.fn(async (_id: string, fields: Partial<SessionRecord>) => {
    if (options.updateError) throw options.updateError;
    return current ? { ...current, ...fields } : undefined;
  });
  const refresh: SessionToolCallModeRefresh = {
    policy,
    sessions: { get: vi.fn(async () => current), update },
  };
  return { refresh, update, logger };
}

describe('refreshToolCallModeAfterCompaction', () => {
  it.each([
    ['native', 'ptc'],
    ['ptc', 'native'],
  ] as const)('switches a Session from %s to %s and logs it', async (from, to) => {
    const { refresh, update, logger } = harness(session({ toolCallMode: from }), to);

    await refreshToolCallModeAfterCompaction(refresh, 'session-1', 'llm_checkpoint');

    expect(update).toHaveBeenCalledOnce();

    expect(update).toHaveBeenCalledWith('session-1', { toolCallMode: to });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { session_id: 'session-1', from, to, trigger: 'compaction' },
      'ptc session mode switched',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reads a Session created before the field existed as native', async () => {
    const { refresh, update, logger } = harness(session(), 'ptc');

    await refreshToolCallModeAfterCompaction(refresh, 'session-1', 'llm_checkpoint');

    expect(update).toHaveBeenCalledOnce();

    expect(update).toHaveBeenCalledWith('session-1', { toolCallMode: 'ptc' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'native', to: 'ptc' }),
      'ptc session mode switched',
    );
  });

  it.each([
    ['ptc', 'ptc'],
    ['native', 'native'],
    [undefined, 'native'],
  ] as const)('neither writes nor logs when the mode is unchanged (%s -> %s)', async (from, to) => {
    const { refresh, update, logger } = harness(session({ toolCallMode: from }), to);

    await refreshToolCallModeAfterCompaction(refresh, 'session-1', 'llm_checkpoint');

    expect(update).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  const SESSION_KINDS = [
    ['a root conversation', session()],
    ['a Task child', session({ sessionKind: 'task', parentSessionId: 'parent' })],
    ['a child conversation', session({ parentSessionId: 'parent' })],
    ['a Peek Session', session({ sessionKind: 'peek', parentSessionId: 'parent' })],
    ['a channel Session', session({ sessionKind: 'channel' })],
    ['a cron Session', session({ sessionKind: 'cron' })],
  ] as const;

  it.each(SESSION_KINDS)(
    'adopts the current switch for %s after a summary compaction',
    async (_label, current) => {
      for (const [from, to] of [
        ['native', 'ptc'],
        ['ptc', 'native'],
      ] as const) {
        const { refresh, update, logger } = harness({ ...current, toolCallMode: from }, to);

        await expect(
          refreshToolCallModeAfterCompaction(refresh, 'session-1', 'llm_checkpoint'),
        ).resolves.toBeUndefined();

        expect(update).toHaveBeenCalledWith('session-1', { toolCallMode: to });
        expect(logger.info).toHaveBeenCalledWith(
          { session_id: 'session-1', from, to, trigger: 'compaction' },
          'ptc session mode switched',
        );
      }
    },
  );

  it.each(SESSION_KINDS)(
    'keeps the mode of %s after a tool result compaction or without a known method, even with the switch changed',
    async (_label, current) => {
      for (const method of ['tool_archive', 'tool_trim', undefined] as const) {
        for (const [from, to] of [
          ['native', 'ptc'],
          ['ptc', 'native'],
        ] as const) {
          const { refresh, update, logger } = harness({ ...current, toolCallMode: from }, to);

          await expect(
            refreshToolCallModeAfterCompaction(refresh, 'session-1', method),
          ).resolves.toBeUndefined();

          expect(update).not.toHaveBeenCalled();
          expect(logger.info).toHaveBeenCalledOnce();
          expect(logger.info).toHaveBeenCalledWith(
            { session_id: 'session-1', method: method ?? 'unknown', from, to },
            'ptc session mode refresh skipped',
          );
          expect(logger.warn).not.toHaveBeenCalled();
        }
      }
    },
  );

  it('logs no skipped refresh when a tool result compaction finds the mode current', async () => {
    const { refresh, update, logger } = harness(session({ toolCallMode: 'ptc' }), 'ptc');

    await refreshToolCallModeAfterCompaction(refresh, 'session-1', 'tool_archive');

    expect(update).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('leaves a missing Session alone', async () => {
    const { refresh, update, logger } = harness(undefined, 'ptc');

    await expect(
      refreshToolCallModeAfterCompaction(refresh, 'session-1', 'llm_checkpoint'),
    ).resolves.toBeUndefined();

    expect(update).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does nothing without a policy', async () => {
    await expect(
      refreshToolCallModeAfterCompaction(undefined, 'session-1', 'llm_checkpoint'),
    ).resolves.toBe(undefined);
  });

  it('never fails the committed compaction when the write fails', async () => {
    const { refresh, logger } = harness(session({ toolCallMode: 'native' }), 'ptc', {
      updateError: new Error('database is locked'),
    });

    await expect(
      refreshToolCallModeAfterCompaction(refresh, 'session-1', 'llm_checkpoint'),
    ).resolves.toBeUndefined();

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      { session_id: 'session-1', trigger: 'compaction', reason: 'database is locked' },
      'ptc session mode switch failed',
    );
  });

  it('swallows a throwing logger', async () => {
    const { refresh, update, logger } = harness(session({ toolCallMode: 'native' }), 'ptc');
    logger.info.mockImplementation(() => {
      throw new Error('logger down');
    });

    await expect(
      refreshToolCallModeAfterCompaction(refresh, 'session-1', 'llm_checkpoint'),
    ).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledOnce();
  });
});
