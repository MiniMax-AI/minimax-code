import { createHash } from 'node:crypto';
import {
  canonicalActiveHistoryRevision,
  canonicalHistoryRevision,
  CanonicalHistoryJsonlDataSource,
  decodeCanonicalHistoryEnvelope,
} from '../packages/local-runtime-v2/src/infra/file/canonical-history-jsonl.js';
import { canonicalJson } from '../packages/local-runtime-v2/src/infra/file/canonical-history-json-value.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseClient } from '../packages/local-runtime-v2/src/infra/db/client.js';
import { initializeDatabase } from '../packages/local-runtime-v2/src/infra/db/initialize.js';
import { queryCollapseViewStates } from '../packages/local-runtime-v2/src/infra/db/schema/query-collapse.js';
import { turnIngress } from '../packages/local-runtime-v2/src/infra/db/schema/turn.js';
import { createQueryCollapseState } from '../packages/local-runtime-v2/src/service/session-system/query-collapse-state.js';
import { createQueueTurnAdmissionPriorityFence } from '../packages/local-runtime-v2/src/service/session-system/index.js';
import { createTurnRepository } from '../packages/local-runtime-v2/src/service/turn-system/persistence/turn.repository.js';
import { IncrementalSha256 } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/incremental-sha256.js';
import { captureSemanticSnapshot } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/semantic-identity.js';
import { DurableCanonicalHistoryStore } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/durable-canonical-history-store.js';
import type { CanonicalHistoryChange } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/contracts.js';
import { BpeTokenEstimator } from '../packages/agent-modules/context-manager/src/token-estimator.js';
import { ensureCanonicalHistoryMaterialized } from '../packages/local-runtime-v2/src/service/session-system/messages/history/canonical-history-materializer.js';
import { createSessionSystemCanonicalHistoryProvider } from '../packages/local-runtime-v2/src/service/session-system/messages/history/canonical-history-provider.js';
import { createCanonicalHistoryFileAdapter } from '../packages/local-runtime-v2/src/service/session-system/sessions/representation/canonical-history.js';
import {
  resolveSessionHistoryPaths,
  utcSessionHistoryRelativeDir,
} from '../packages/local-runtime-v2/src/service/session-system/messages/history/session-history-paths.js';
import type { SessionRecord } from '../packages/local-runtime-v2/src/service/session-system/sessions/repo/contract.js';

describe('prepared runtime reads', () => {
  async function withDatabase(
    run: (client: DatabaseClient, writer: DatabaseClient) => Promise<void>,
  ) {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-prepared-reads-'));
    const client = new DatabaseClient({ dataDir });
    const writer = new DatabaseClient({ dataDir });
    try {
      await initializeDatabase({ database: client, dataDir });
      await run(client, writer);
    } finally {
      writer.close();
      client.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  it('keeps processing reads fresh across sessions, completion and another connection', async () => {
    await withDatabase(async (client, writer) => {
      const state = createQueryCollapseState({ db: client.db, nowMs: () => 1 });
      expect(await state.findProcessingByCurrentTurn('s1', 't1')).toBeUndefined();
      await state.start({ sessionId: 's1', currentTurnId: 't1', queryKey: 'a' });
      await state.start({ sessionId: 's1', currentTurnId: 't1', queryKey: 'b' });
      await state.start({ sessionId: 's2', currentTurnId: 't1', queryKey: 'other' });
      expect((await state.findProcessingByCurrentTurn('s1', 't1'))?.queryKey).toBe('b');
      expect((await state.findProcessingByCurrentTurn('s2', 't1'))?.queryKey).toBe('other');
      expect(await state.findProcessingByCurrentTurn('s1', 'missing')).toBeUndefined();
      await state.finish({
        sessionId: 's1',
        currentTurnId: 't1',
        queryKey: 'b',
        forceExpanded: false,
      });
      expect((await state.findProcessingByCurrentTurn('s1', 't1'))?.queryKey).toBe('a');
      writer.db
        .update(queryCollapseViewStates)
        .set({ processingFinishedAtMs: 2 })
        .where(eq(queryCollapseViewStates.sessionId, 's1'))
        .run();
      expect(await state.findProcessingByCurrentTurn('s1', 't1')).toBeUndefined();
      expect((await state.findProcessingByCurrentTurn('s2', 't1'))?.queryKey).toBe('other');
      client.close();
      const reopened = createQueryCollapseState({ db: client.db });
      expect((await reopened.findProcessingByCurrentTurn('s2', 't1'))?.queryKey).toBe('other');
    });
  });

  it('rereads receipts and validates corruption after a previous successful lookup', async () => {
    await withDatabase(async (client, writer) => {
      const repository = createTurnRepository({
        db: client.db,
        priorityFence: createQueueTurnAdmissionPriorityFence(),
        sessionAdmission: { rejectionInTransaction: () => undefined },
      });
      expect(await repository.findReceipt('turn-1')).toBeUndefined();
      for (let i = 1; i <= 2; i += 1) {
        writer.db
          .insert(turnIngress)
          .values({
            turnId: `turn-${i}`,
            sessionId: `s${i}`,
            busyReason: 'turn',
            inputJson: '{}',
            status: 'accepted',
            acceptedAtMs: 1,
            acceptedSequence: i,
            inputDigest: `digest-${i}`,
          })
          .run();
      }
      expect(await repository.findReceipt('turn-1')).toMatchObject({
        sessionId: 's1',
        acceptedSequence: 1,
      });
      expect(await repository.findReceipt('turn-2')).toMatchObject({
        sessionId: 's2',
        acceptedSequence: 2,
      });
      writer.db
        .update(turnIngress)
        .set({ inputDigest: '' })
        .where(eq(turnIngress.turnId, 'turn-1'))
        .run();
      await expect(repository.findReceipt('turn-1')).rejects.toThrow('malformed');
      writer.db
        .update(turnIngress)
        .set({ inputDigest: 'edited', acceptedSequence: 3 })
        .where(eq(turnIngress.turnId, 'turn-1'))
        .run();
      expect(await repository.findReceipt('turn-1')).toMatchObject({
        inputDigest: 'edited',
        acceptedSequence: 3,
      });
      writer.db.delete(turnIngress).where(eq(turnIngress.turnId, 'turn-1')).run();
      expect(await repository.findReceipt('turn-1')).toBeUndefined();
      expect(await repository.findReceipt("turn-2' OR 1=1 --")).toBeUndefined();
    });
  });
});

describe('native incremental semantic hashing', () => {
  const inputs = ['', 'abc', '中文🙂', '\ud800', '\udc00', 'a'.repeat(8191) + '🙂tail'];
  for (const length of [55, 56, 63, 64, 65, 8191, 8192, 8193, 32769]) {
    inputs.push('x'.repeat(length), '中'.repeat(length));
  }
  it.each(inputs)('preserves UTF-8 hashing %#', (input) => {
    const hash = new IncrementalSha256();
    hash.update(input);
    expect(hash.digestHex()).toBe(createHash('sha256').update(input).digest('hex'));
    expect(() => hash.update('')).toThrow('finalized');
    expect(() => hash.digestHex()).toThrow('finalized');
  });
  it('preserves encoding boundaries between separate updates', () => {
    const hash = new IncrementalSha256();
    hash.update('\ud83d');
    hash.update('\ude42');
    expect(hash.digestHex()).toBe(
      createHash('sha256').update('\ud83d').update('\ude42').digest('hex'),
    );
  });
  it('matches native updates across repeated batches and split surrogate pairs', () => {
    const actual = new IncrementalSha256();
    const expected = createHash('sha256');
    const parts = ['key', ':', '', '\ud83d', '\ude42', '中文🙂', 'x'.repeat(8191), '🙂tail'];
    for (let index = 0; index < 257; index += 1) {
      for (const part of parts) {
        actual.update(part);
        expected.update(part, 'utf8');
      }
    }
    expect(actual.digestHex()).toBe(expected.digest('hex'));
  });
});

describe('streamed canonical history revisions', () => {
  it.each([0, 1, 100])('preserves the canonical JSON digest for %i records', (length) => {
    const records = Array.from({ length }, (_, index) => ({
      message_id: `msg-${index}`,
      turn_id: `turn-${index}`,
      message: {
        role: 'user',
        timestamp: index,
        content: '中文🙂\ud800'.repeat(2048),
        metadata: { z: [null, true, -0], '10': 'ten', '2': 'two', a: { b: '"\\\n' } },
      },
    }));
    const expected = `sha256:${createHash('sha256')
      .update(canonicalJson(records.map(decodeCanonicalHistoryEnvelope)), 'utf8')
      .digest('hex')}`;
    expect(canonicalHistoryRevision(records)).toBe(expected);
    expect(canonicalActiveHistoryRevision(records)).toBe(expected);
    if (records.length > 0) {
      records[0]!.message.content = 'edited';
      expect(canonicalHistoryRevision(records)).not.toBe(expected);
    }
  });
  it('keeps active and settled sequence validation distinct', () => {
    const pending = [
      {
        message_id: 'msg-assistant',
        turn_id: 'turn-1',
        message: {
          role: 'assistant',
          timestamp: 1,
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
          ],
        },
      },
    ];
    const expected = `sha256:${createHash('sha256')
      .update(canonicalJson(pending.map(decodeCanonicalHistoryEnvelope)), 'utf8')
      .digest('hex')}`;
    expect(canonicalActiveHistoryRevision(pending)).toBe(expected);
    expect(() => canonicalHistoryRevision(pending)).toThrow('tool results');
    expect(() => canonicalActiveHistoryRevision([pending[0]!, pending[0]!])).toThrow();
  });
});

describe('semantic snapshots', () => {
  it('detaches and freezes eagerly but hashes only when identity is requested', () => {
    const hash = vi.spyOn(IncrementalSha256.prototype, 'update');
    try {
      const original = { messages: [{ text: 'before' }] };
      const snapshot = captureSemanticSnapshot(original);
      original.messages[0]!.text = 'after';
      expect(snapshot.value.messages[0]!.text).toBe('before');
      expect(Object.isFrozen(snapshot.value.messages[0])).toBe(true);
      expect(hash).not.toHaveBeenCalled();
      const reused = captureSemanticSnapshot(snapshot.value);
      expect(reused.value).toBe(snapshot.value);
      const wrapped = captureSemanticSnapshot({
        history: snapshot.value.messages,
      });
      expect(wrapped.value.history).toBe(snapshot.value.messages);
      expect(wrapped.value.history).toEqual(snapshot.value.messages);
      const fingerprint = snapshot.fingerprint;
      expect(hash).toHaveBeenCalled();
      hash.mockClear();
      expect(reused.fingerprint).toBe(fingerprint);
      expect(hash).not.toHaveBeenCalled();
      expect(captureSemanticSnapshot(original).fingerprint).not.toBe(fingerprint);
    } finally {
      hash.mockRestore();
    }
  });
  it('shares owned history through delivery wrappers and detaches other branches', () => {
    const history = captureSemanticSnapshot({
      messages: [{ text: 'body' }],
    }).value;
    const external = { nested: { id: 1 } };
    const delivered = captureSemanticSnapshot({
      committedMessages: history.messages,
      external,
    });
    const event = captureSemanticSnapshot({
      context: external,
      change: delivered.value,
    });
    external.nested.id = 2;
    expect(delivered.value.committedMessages).toBe(history.messages);
    expect(event.value.change).toBe(delivered.value);
    expect(event.value.context.nested.id).toBe(1);
    expect(event.value.change.external.nested.id).toBe(1);
    expect(Object.isFrozen(event.value.context.nested)).toBe(true);
    expect(event.fingerprint).toBe(
      captureSemanticSnapshot(structuredClone(event.value)).fingerprint,
    );
  });
  it('preserves aliases, sparse arrays and own __proto__ fields in owned wrappers', () => {
    const owned = captureSemanticSnapshot({ value: 'owned' }).value;
    const shared = { owned };
    const array = new Array(3);
    array[2] = shared;
    const input = { owned, a: shared, b: shared, array, ['__proto__']: shared };
    const snapshot = captureSemanticSnapshot(input);
    expect(snapshot.value.a).toBe(snapshot.value.b);
    expect(snapshot.value.a).toBe(snapshot.value.array[2]);
    expect(snapshot.value['__proto__']).toBe(snapshot.value.a);
    expect(0 in snapshot.value.array).toBe(false);
    expect(snapshot.value).toEqual(structuredClone(input));
    const cycle: Record<string, unknown> = { owned };
    cycle.self = cycle;
    expect(() => captureSemanticSnapshot(cycle)).toThrow('Cyclic');
  });
  it('uses native getter ordering and proxy rejection even beside owned values', () => {
    const owned = captureSemanticSnapshot({ text: 'owned' }).value;
    const shared = { value: 1 };
    const getter = vi.fn(() => {
      shared.value = 2;
      return shared;
    });
    const snapshot = captureSemanticSnapshot({
      owned,
      shared,
      get later() {
        return getter();
      },
    });
    expect(snapshot.value.shared).toBe(snapshot.value.later);
    expect(snapshot.value.shared.value).toBe(1);
    expect(getter).toHaveBeenCalledTimes(1);
    const trap = vi.fn();
    expect(() =>
      captureSemanticSnapshot({
        owned,
        proxy: new Proxy({}, { ownKeys: trap }),
      }),
    ).toThrow();
    expect(trap).not.toHaveBeenCalled();
  });
  it('does not trust externally frozen objects with mutable descendants', () => {
    const original = Object.freeze({ nested: { text: 'before' } });
    const snapshot = captureSemanticSnapshot(original);
    original.nested.text = 'after';
    expect(snapshot.value.nested.text).toBe('before');
  });
  it('preserves native rejection of proxies without invoking their traps', () => {
    const trap = vi.fn();
    const value = new Proxy({}, { ownKeys: trap });
    expect(() => captureSemanticSnapshot(value)).toThrow();
    expect(trap).not.toHaveBeenCalled();
  });
  it('preserves native enumeration when an accessor deletes another field', () => {
    const value = {
      get first() {
        delete this.second;
        return 'first';
      },
      second: 'deleted' as string | undefined,
    };
    expect(captureSemanticSnapshot(value).value).toEqual({ first: 'first' });
  });
  it.each([false, true])(
    'preserves shared references across a mutating getter (getter first: %s)',
    (getterFirst) => {
      const makeInput = () => {
        const shared = { value: 1 };
        const getter = vi.fn(() => {
          shared.value = 2;
          return shared;
        });
        const nested = {
          get shared() {
            return getter();
          },
        };
        return {
          input: getterFirst ? { nested, shared } : { shared, nested },
          getter,
        };
      };
      const expected = structuredClone(makeInput().input);
      const { input, getter } = makeInput();
      const snapshot = captureSemanticSnapshot(input);
      expect(snapshot.value).toEqual(expected);
      expect(snapshot.value.shared).toBe(snapshot.value.nested.shared);
      expect(snapshot.fingerprint).toBe(captureSemanticSnapshot(expected).fingerprint);
      expect(getter).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves shared references across a class instance normalized by native cloning', () => {
    const shared = { value: 1 };
    class Container {
      child = shared;
    }
    const snapshot = captureSemanticSnapshot({
      shared,
      nested: new Container(),
    });
    expect(snapshot.value.shared).toBe(snapshot.value.nested.child);
    expect(Object.getPrototypeOf(snapshot.value.nested)).toBe(Object.prototype);
  });
  it.each([new Date(), new Map(), new Uint8Array([1]), 1n])(
    'rejects unsupported value-only payloads %#',
    (value) => {
      expect(() => captureSemanticSnapshot(value).value).toThrow();
    },
  );
  it('rejects cycles eagerly and accepts shared acyclic objects', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => captureSemanticSnapshot(cyclic).value).toThrow('Cyclic');
    const shared = { value: 'same' };
    expect(captureSemanticSnapshot([shared, shared]).fingerprint).toBe(
      captureSemanticSnapshot([{ value: 'same' }, { value: 'same' }]).fingerprint,
    );
  });
  it('retains ordering, framing and special number distinctions', () => {
    const fingerprint = (value: unknown) => captureSemanticSnapshot(value).fingerprint;
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    expect(
      new Set(
        [
          undefined,
          null,
          NaN,
          Infinity,
          -Infinity,
          -0,
          0,
          '',
          [],
          Array(1),
          [undefined],
          {},
          { a: undefined },
        ].map(fingerprint),
      ).size,
    ).toBe(13);
    expect(fingerprint(['ab', 'c'])).not.toBe(fingerprint(['a', 'bc']));
  });
});

describe('bounded token count reuse', () => {
  it('reuses text across detached histories and observes content edits and compaction', () => {
    const encode = vi.fn((text: string) => [...text]);
    const estimator = new BpeTokenEstimator(encode);
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'old' }],
        timestamp: 0,
      },
    ];
    expect(estimator.estimateMessages(messages)).toBe(7);
    expect(estimator.estimateMessages(structuredClone(messages))).toBe(7);
    expect(encode).toHaveBeenCalledTimes(1);
    messages[0]!.content[0]!.text = 'replacement';
    expect(estimator.estimateMessages(messages)).toBe(15);
    expect(estimator.estimateMessages([])).toBe(0);
    expect(estimator.estimateMessages([{ role: 'user', content: 'summary', timestamp: 1 }])).toBe(
      11,
    );
    expect(encode).toHaveBeenCalledTimes(3);
  });
  it.each([256, 257, 300])(
    'reuses detached histories above the former text budget (%i messages)',
    (count) => {
      const encode = vi.fn(() => [1]);
      const estimator = new BpeTokenEstimator(encode);
      const messages = Array.from({ length: count }, (_, i) => ({
        role: 'user' as const,
        content: String(i).padStart(8, '0') + 'x '.repeat(2044),
        timestamp: i,
      }));
      const first = estimator.estimateMessages(messages);
      encode.mockClear();
      expect(estimator.estimateMessages(structuredClone(messages))).toBe(first);
      expect(encode).not.toHaveBeenCalled();
      messages[0]!.content = 'changed ' + messages[0]!.content.slice(8);
      estimator.estimateMessages(messages);
      expect(encode).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps distinct malformed UTF-16 strings separate in long-text keys', () => {
    const prefix = 'x '.repeat(256);
    const estimator = new BpeTokenEstimator((text) => (text.endsWith('\ud800') ? [1] : [1, 2]));
    expect(estimator.estimateTextTokens(prefix + '\ud800')).toBe(1);
    expect(estimator.estimateTextTokens(prefix + '\ud801')).toBe(2);
  });
  it('isolates different estimators and evicts least-recently-used text', () => {
    const encode = vi.fn((text: string) => [...text]);
    const estimator = new BpeTokenEstimator(encode);
    estimator.estimateTextTokens('old');
    for (let i = 0; i < 2048; i++) estimator.estimateTextTokens(`text ${i}`);
    encode.mockClear();
    estimator.estimateTextTokens('old');
    expect(encode).toHaveBeenCalledTimes(1);
    expect(new BpeTokenEstimator(() => [0]).estimateTextTokens('old')).toBe(1);
  });
  it('reuses large texts without retaining their bodies', () => {
    const encode = vi.fn(() => [1]);
    const estimator = new BpeTokenEstimator(encode);
    const first = 'a '.repeat(300_000);
    const second = 'b '.repeat(300_000);
    estimator.estimateTextTokens(first);
    estimator.estimateTextTokens(second);
    estimator.estimateTextTokens(first);
    expect(encode).toHaveBeenCalledTimes(2);
  });
  it('does not cache tokenizer failures', () => {
    const encode = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('transient');
      })
      .mockReturnValue([1]);
    const estimator = new BpeTokenEstimator(encode);
    expect(estimator.estimateTextTokens('中文')).toBe(6);
    expect(estimator.estimateTextTokens('中文')).toBe(1);
  });
});

describe('committed history read reuse', () => {
  it('reuses verified records for indexing while observing external changes and corruption', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-history-reuse-'));
    const redundantRead = vi.spyOn(CanonicalHistoryJsonlDataSource.prototype, 'readActive');
    try {
      const session: SessionRecord = {
        sessionId: 'synthetic-session',
        agentName: 'test',
        workspaceDir: dataDir,
        runtime: 'pi-agent',
        sessionType: 'root',
        sessionKind: 'conversation',
        archived: false,
        status: 'idle',
        createdAtMs: 0,
        updatedAtMs: 0,
        historyRelativeDir: utcSessionHistoryRelativeDir('synthetic-session', 0),
      };
      const files = createCanonicalHistoryFileAdapter();
      const strictRead = vi.spyOn(files, 'readActiveStrict');
      const provider = createSessionSystemCanonicalHistoryProvider({
        dataDir,
        sessions: { get: async () => session },
        files,
      });
      await provider.initialize(session.sessionId);
      strictRead.mockClear();
      redundantRead.mockClear();
      expect((await provider.readActive(session.sessionId)).messages).toEqual([]);
      expect(strictRead).not.toHaveBeenCalled();
      const committed = await provider.append({
        sessionId: session.sessionId,
        turnId: 'turn-1',
        reason: 'messageDelta',
        messages: [{ role: 'user', content: 'first', timestamp: 1 }],
        operation: { id: 'append-1', kind: 'append' },
      });
      expect(committed.messages).toHaveLength(1);
      expect(strictRead).toHaveBeenCalledTimes(1);
      expect(redundantRead).not.toHaveBeenCalled();
      const paths = resolveSessionHistoryPaths(dataDir, session);
      const external = createCanonicalHistoryFileAdapter();
      await external.replace(paths.messages, [
        {
          message_id: 'msg-external-id',
          turn_id: 'turn-2',
          message: { role: 'user', content: 'edited', timestamp: 2 },
        },
      ]);
      expect((await provider.readActive(session.sessionId)).messages[0]).toMatchObject({
        content: 'edited',
      });
      await writeFile(paths.messages, '{invalid json}\n');
      await expect(provider.readActive(session.sessionId)).rejects.toThrow();
      await expect(
        provider.append({
          sessionId: session.sessionId,
          turnId: 'turn-3',
          reason: 'messageDelta',
          messages: [{ role: 'user', content: 'must not append', timestamp: 3 }],
          operation: { id: 'append-3', kind: 'append' },
        }),
      ).rejects.toThrow();
    } finally {
      redundantRead.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  it('checks migration target existence without reparsing and preserves legacy adapter fallback', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-materialized-'));
    try {
      const sessionId = 'synthetic-session';
      const paths = resolveSessionHistoryPaths(dataDir, {
        sessionId,
        createdAtMs: 0,
      });
      const files = createCanonicalHistoryFileAdapter();
      const read = vi.spyOn(files, 'readTarget');
      const options = { sessionId, paths, files, nowMs: () => 0 };
      await ensureCanonicalHistoryMaterialized(options);
      const legacyHistory = {
        sources: {
          readLedgerSnapshot: vi.fn(async () => undefined),
          readSqliteRows: vi.fn(async () => []),
          readSqliteBlob: vi.fn(async () => []),
        },
        checkpoints: {
          getCheckpoint: async () => ({
            sessionId,
            migratedAtMs: 0,
            source: 'empty' as const,
            messageCount: 0,
            targetRevision: 'recorded',
          }),
          upsertCheckpoint: vi.fn(async () => {}),
        },
      };
      await ensureCanonicalHistoryMaterialized({ ...options, legacyHistory });
      expect(read).not.toHaveBeenCalled();
      expect(legacyHistory.sources.readLedgerSnapshot).not.toHaveBeenCalled();
      Object.defineProperty(files, 'targetExists', { value: undefined });
      await ensureCanonicalHistoryMaterialized({ ...options, legacyHistory });
      expect(read).toHaveBeenCalledTimes(1);
      await rm(paths.messages);
      await expect(
        ensureCanonicalHistoryMaterialized({ ...options, legacyHistory }),
      ).rejects.toThrow('missing after migration');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  it('retains disk reads for standalone appends and validates supplied prefix identities', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-append-prefix-'));
    try {
      const source = new CanonicalHistoryJsonlDataSource({
        activePath: join(dataDir, 'messages.jsonl'),
      });
      await source.publishInitial([]);
      const first = {
        message_id: 'msg-first',
        turn_id: 'turn-first',
        message: { role: 'user', content: 'first', timestamp: 1 },
      };
      const second = {
        message_id: 'msg-second',
        turn_id: 'turn-second',
        message: { role: 'user', content: 'second', timestamp: 2 },
      };
      const read = vi.spyOn(source, 'readActive');
      await source.append([first]);
      expect(read).toHaveBeenCalledTimes(1);
      const verified = await source.readActiveStrict();
      read.mockClear();
      await expect(source.append([first], verified)).rejects.toThrow();
      await source.append([second], verified);
      expect(read).not.toHaveBeenCalled();
      expect((await source.readActiveStrict()).map((row) => row.message_id)).toEqual([
        'msg-first',
        'msg-second',
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  const change: CanonicalHistoryChange = {
    sessionId: 'synthetic-session',
    turnId: 'synthetic-turn',
    reason: 'messageDelta',
    messages: [],
    operation: { id: 'append-1', kind: 'append' },
  };
  it('uses the provider commit without a second read and still reads fresh on demand', async () => {
    const committed = { revision: 'r1', messages: [], identityVector: [] };
    const read = vi.fn(async () => ({
      revision: 'r2',
      messages: [],
      identityVector: [],
    }));
    const readActive = vi.fn(async () => committed);
    const store = new DurableCanonicalHistoryStore({
      read,
      readActive,
      append: async () => committed,
      replace: async () => committed,
    });
    const result = await store.append(change);
    committed.revision = 'mutated';
    expect(result.revision).toBe('r1');
    expect(readActive).not.toHaveBeenCalled();
    expect((await store.read('synthetic-session')).revision).toBe('r2');
  });
  it('preserves owned history through the store and the next commit snapshot', async () => {
    const original = {
      revision: ' r1 ',
      messages: [{ role: 'user', timestamp: 1, content: 'original'.repeat(4096) }],
      identityVector: ['msg-1'],
    };
    const store = new DurableCanonicalHistoryStore({
      read: async () => original,
      readActive: async () => original,
      append: async () => original,
      replace: async () => original,
    });
    const committed = await store.append(change);
    const expectedContent = original.messages[0]!.content;
    original.messages[0]!.content = 'changed';
    original.identityVector[0] = 'changed';
    expect(committed.revision).toBe('r1');
    expect(committed.messages).toEqual([{ role: 'user', timestamp: 1, content: expectedContent }]);
    expect(committed.identityVector).toEqual(['msg-1']);
    expect(Object.isFrozen(committed.messages[0])).toBe(true);
    expect(Object.isFrozen(committed.messages)).toBe(true);
    expect(Object.isFrozen(committed.identityVector)).toBe(true);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      expect(captureSemanticSnapshot(committed).value).toBe(committed);
      expect(
        captureSemanticSnapshot({ committedMessages: committed.messages }).value.committedMessages,
      ).toBe(committed.messages);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    const sharedEmpty: never[] = [];
    const emptyStore = new DurableCanonicalHistoryStore({
      read: async () => ({ revision: 'r2', messages: sharedEmpty, identityVector: sharedEmpty }),
      readActive: async () => original,
      append: async () => original,
      replace: async () => original,
    });
    const empty = await emptyStore.read('synthetic-session');
    expect(empty.messages).not.toBe(empty.identityVector);
    expect(empty.messages).toEqual([]);
  });
  it('retains legacy rereads and rejects invalid commits or write failures', async () => {
    const readActive = vi.fn(async () => ({
      revision: 'r1',
      messages: [],
      identityVector: [],
    }));
    const append = vi.fn<
      () => Promise<ReturnType<typeof readActive> extends Promise<infer T> ? T | void : never>
    >(async () => undefined);
    const store = new DurableCanonicalHistoryStore({
      read: readActive,
      readActive,
      append,
      replace: async () => undefined,
    });
    expect((await store.append(change)).revision).toBe('r1');
    expect(readActive).toHaveBeenCalledTimes(1);
    append.mockResolvedValueOnce({
      revision: '',
      messages: [],
      identityVector: [],
    });
    await expect(store.append(change)).rejects.toThrow();
    append.mockRejectedValueOnce(new Error('write failed'));
    await expect(store.append(change)).rejects.toThrow('write failed');
    expect(readActive).toHaveBeenCalledTimes(1);
  });
});
