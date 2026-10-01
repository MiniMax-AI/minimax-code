import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createProductionConversationMutationWorkflow } from '../../src/application/session/conversation-mutation-workflow.js';
import {
  canonicalHistoryRevision,
  inspectCanonicalHistorySequence,
  type CanonicalHistoryEnvelope,
} from '../../src/infra/file/canonical-history.js';
import { createSessionForkDisplayCapability } from '../../src/service/session-system/fork/display-data-capability.js';
import { createSessionHistoryMutationAdapter } from '../../src/service/session-system/messages/history/mutation/session-history-mutation-adapter.js';
import { resolveSessionHistoryPaths } from '../../src/service/session-system/messages/history/session-history-paths.js';
import { createSessionOperationIntentRepository } from '../../src/service/session-system/mutation/operation-intent-repository.js';
import type { SessionRecord } from '../../src/service/session-system/sessions/repo/contract.js';
import { createHistoryMutationCapability } from '../../src/service/turn-system/lifecycle/history-mutation-capability.js';

const user: CanonicalHistoryEnvelope = {
  message_id: 'msg-user-v1-question',
  turn_id: 'turn',
  message: { role: 'user', content: 'question', timestamp: 1 },
};
const answer: CanonicalHistoryEnvelope = {
  message_id: 'msg-answer',
  turn_id: 'turn',
  message: { role: 'assistant', content: [{ type: 'text', text: 'progress' }], timestamp: 2 },
};
function call(ids: string[]): CanonicalHistoryEnvelope {
  return {
    message_id: 'msg-call',
    turn_id: 'turn',
    message: {
      role: 'assistant',
      content: ids.map((id) => ({
        type: 'toolCall',
        id,
        name: 'task_output',
        arguments: { task_id: id, wait_ms: 30000 },
      })),
      timestamp: 3,
    },
  };
}
function result(id: string): CanonicalHistoryEnvelope {
  return {
    message_id: `msg-result-${id}`,
    turn_id: 'turn',
    message: {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'task_output',
      content: [{ type: 'text', text: 'running' }],
      isError: false,
      timestamp: 4,
    },
  };
}
const cases = [
  { name: 'pending tool', rows: [user, answer, call(['one'])], retained: [user, answer] },
  {
    name: 'persisted result without a later assistant',
    rows: [user, answer, call(['one']), result('one')],
    retained: [user, answer, call(['one']), result('one')],
  },
  {
    name: 'partially completed parallel tools',
    rows: [user, answer, call(['one', 'two']), result('one')],
    retained: [user, answer],
  },
  {
    name: 'completed parallel tools',
    rows: [user, answer, call(['one', 'two']), result('two'), result('one')],
    retained: [user, answer, call(['one', 'two']), result('two'), result('one')],
  },
  { name: 'first assistant is a pending tool', rows: [user, call(['one'])], retained: [user] },
];

async function writeHistory(path: string, rows: readonly CanonicalHistoryEnvelope[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

async function fixture(rows: readonly CanonicalHistoryEnvelope[], archived: boolean) {
  const dataDir = await mkdtemp(join(tmpdir(), 'btw-settled-'));
  const source: SessionRecord = {
    sessionId: 'source',
    agentName: 'mavis',
    workspaceDir: dataDir,
    runtime: 'pi-agent',
    sessionType: 'root',
    sessionKind: 'conversation',
    archived: false,
    status: 'started',
    sessionOrigin: 'local-runtime',
    sessionDataVersion: 4,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  let child: SessionRecord | undefined;
  const paths = resolveSessionHistoryPaths(dataDir, source);
  const active = archived
    ? rows.map((row, index) =>
        index
          ? row
          : {
              ...row,
              history_artifact: {
                schemaVersion: 1 as const,
                generation: 1,
                producedBy: 'tool_archive' as const,
                parentSnapshot: {
                  generation: 0,
                  compactionId: 'before',
                  revision: canonicalHistoryRevision([user, answer]),
                },
              },
            },
      )
    : rows;
  await writeHistory(paths.messages, active);
  if (archived)
    await writeHistory(join(paths.snapshots, 'g000000000000--before.jsonl'), [user, answer]);
  const sessions = { get: async (id: string) => (id === 'source' ? source : child) };
  const history = createSessionHistoryMutationAdapter({ dataDir, sessions });
  const displayRows = [
    {
      msg_id: 'display-assistant',
      role: 'assistant' as const,
      source: 'streaming',
      canonical_message_id: 'msg-call',
    },
  ];
  const display = createSessionForkDisplayCapability(
    {
      list: async () => ({ messages: displayRows }),
      deleteSessionData: async () => undefined,
    } as never,
    history,
  );
  const turn = createHistoryMutationCapability({
    sessions: history,
    forkProjections: { forkPrefix: async () => undefined },
    rewindProjections: {
      preflight: async () => undefined,
      apply: async () => ({ status: 'no-diff' }),
      deleteTurns: async () => undefined,
    },
  });
  const operations = createSessionOperationIntentRepository();
  const create = vi.fn(async (input: Record<string, unknown>) => {
    child = { ...source, ...input, sessionId: 'child', status: 'idle' };
    return child;
  });
  const workflow = createProductionConversationMutationWorkflow({
    operations,
    sessionFork: {
      sessionDataVersion: 4,
      boundary: display.boundary,
      display,
      sessions: {
        ...sessions,
        titleExists: async () => false,
        create,
        delete: async () => {
          child = undefined;
        },
      },
    },
    forkState: { copy: async () => undefined, compensate: async () => undefined },
    turn,
    worktree: { isEligible: async () => false },
    mutationPlanState: { readPlanState: async () => ({ active: false }) },
    publishGlobalEvent: () => undefined,
  } as never);
  const createSideSession = workflow.createSideSession;
  if (!createSideSession) throw new Error('Production side session capability is missing');
  return {
    dataDir,
    source,
    active,
    paths,
    history,
    workflow: { ...workflow, createSideSession },
    create,
  };
}

describe('BTW production fork with persisted tool history', () => {
  it.each(cases.flatMap((test) => [false, true].map((archived) => ({ ...test, archived }))))(
    '$name (archived=$archived)',
    async ({ rows, retained, archived }) => {
      const f = await fixture(rows, archived);
      try {
        const before = await f.history.read('source');
        expect(await f.workflow.getSessionForkOptions({} as never, { id: 'source' })).toMatchObject(
          { canFork: true },
        );
        const child = await f.workflow.createSideSession({
          operationId: 'btw:tools',
          parentSessionId: 'source',
          purpose: 'peek_btw_session',
          title: 'BTW',
        });
        expect(child).toMatchObject({
          visibility: 'hidden',
          sessionKind: 'peek',
          parentSessionId: 'source',
        });
        const saved = await f.history.read(child.sessionId);
        expect(saved.active.slice(0, -1).map((row) => row.message_id)).toEqual(
          retained.map((row) => row.message_id),
        );
        expect(inspectCanonicalHistorySequence(saved.active)).toEqual({ status: 'settled' });
        expect(saved.active.at(-1)?.message).toMatchObject({
          role: 'custom',
          customType: 'btw_side_boundary',
        });
        expect(await f.history.read('source')).toEqual(before);
        expect(saved.activeGeneration).toBe(archived ? 1 : 0);
        expect(saved.snapshots).toEqual(before.snapshots);
      } finally {
        await rm(f.dataDir, { recursive: true, force: true });
      }
    },
  );

  it('pins the selected prefix before child creation while the parent appends more output', async () => {
    const rows = [user, answer, call(['one']), result('one')];
    const f = await fixture(rows, false);
    try {
      const create = f.create.getMockImplementation();
      if (!create) throw new Error('Session creation fixture is missing');
      f.create.mockImplementation(async (input) => {
        await writeHistory(f.paths.messages, [...rows, { ...answer, message_id: 'msg-later' }]);
        return create(input);
      });
      const child = await f.workflow.createSideSession({
        operationId: 'btw:append',
        parentSessionId: 'source',
        purpose: 'peek_btw_session',
      });
      const saved = await f.history.read(child.sessionId);
      expect(saved.active.slice(0, -1).map((row) => row.message_id)).toEqual(
        rows.map((row) => row.message_id),
      );
      expect((await f.history.read('source')).active.at(-1)?.message_id).toBe('msg-later');
    } finally {
      await rm(f.dataDir, { recursive: true, force: true });
    }
  });
});
