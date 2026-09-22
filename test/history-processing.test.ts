import { SemanticReplayRegistry } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/events/semantic-replay-registry.js';
import { createHash } from 'node:crypto';
import { createCanonicalHistoryScanner, scanCanonicalHistoryArtifacts } from '../packages/local-runtime-v2/src/service/session-system/messages/history/mutation/canonical-history-scanner.js';
import {
  canonicalActiveHistoryRevision,
  canonicalHistoryRevision,
  CanonicalHistoryJsonlDataSource,
  decodeCanonicalHistoryEnvelope,
  inspectCanonicalHistorySequence,
  type CanonicalHistoryEnvelope,
} from '../packages/local-runtime-v2/src/infra/file/canonical-history-jsonl.js';
import { canonicalJson } from '../packages/local-runtime-v2/src/infra/file/canonical-history-json-value.js';
import { mkdtemp, rm, writeFile, mkdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseClient } from '../packages/local-runtime-v2/src/infra/db/client.js';
import { initializeDatabase } from '../packages/local-runtime-v2/src/infra/db/initialize.js';
import { queryCollapseViewStates } from '../packages/local-runtime-v2/src/infra/db/schema/query-collapse.js';
import { turnIngress } from '../packages/local-runtime-v2/src/infra/db/schema/turn.js';
import { sessions } from '../packages/local-runtime-v2/src/infra/db/schema/sessions.js';
import { messageRows } from '../packages/local-runtime-v2/src/infra/db/schema/messages.js';
import { createSessionRepository } from '../packages/local-runtime-v2/src/service/session-system/sessions/repo/drizzle.js';
import { createMessageRepository } from '../packages/local-runtime-v2/src/service/session-system/messages/repo/drizzle.js';
import { createQueryCollapseState } from '../packages/local-runtime-v2/src/service/session-system/query-collapse-state.js';
import { createQueueTurnAdmissionPriorityFence } from '../packages/local-runtime-v2/src/service/session-system/index.js';
import { createTurnRepository } from '../packages/local-runtime-v2/src/service/turn-system/persistence/turn.repository.js';
import { IncrementalSha256 } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/incremental-sha256.js';
import {
  captureSemanticSnapshot,
  estimateSemanticValueSize,
} from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/semantic-identity.js';
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

  it('keeps session lookups fresh and enforces the columnar version after reuse', async () => {
    await withDatabase(async (client, writer) => {
      const repository = createSessionRepository({ db: client.db });
      expect(await repository.get('s1')).toBeUndefined();
      for (const sessionId of ['s1', 's2']) {
        await repository.create({
          sessionId,
          agentName: 'test',
          workspaceDir: '/tmp',
          runtime: 'pi-agent',
          title: sessionId,
        });
      }
      expect((await repository.get('s1'))?.title).toBe('s1');
      expect((await repository.get('s2'))?.title).toBe('s2');
      writer.db
        .update(sessions)
        .set({ title: 'updated' })
        .where(eq(sessions.sessionId, 's1'))
        .run();
      expect((await repository.get('s1'))?.title).toBe('updated');
      writer.db
        .update(sessions)
        .set({ columnarVersion: 2 })
        .where(eq(sessions.sessionId, 's1'))
        .run();
      expect(await repository.get('s1')).toBeUndefined();
      writer.db
        .update(sessions)
        .set({ columnarVersion: 3 })
        .where(eq(sessions.sessionId, 's1'))
        .run();
      client.close();
      const reopened = createSessionRepository({ db: client.db });
      expect((await reopened.get('s1'))?.title).toBe('updated');
      writer.db.delete(sessions).where(eq(sessions.sessionId, 's1')).run();
      expect(await reopened.get('s1')).toBeUndefined();
      expect(await reopened.get("s2' OR 1=1 --")).toBeUndefined();
    });
  });

  it('keeps message and turn reads fresh, isolated and ordered after reuse', async () => {
    await withDatabase(async (client, writer) => {
      const sessionRepository = createSessionRepository({ db: client.db });
      for (const sessionId of ['s1', 's2']) {
        await sessionRepository.create({
          sessionId,
          agentName: 'test',
          workspaceDir: '/tmp',
          runtime: 'pi-agent',
        });
      }
      const repository = createMessageRepository({ db: client.db });
      const writerRepository = createMessageRepository({ db: writer.db });
      expect(await repository.get('s1', 'm1')).toBeUndefined();
      expect(await repository.listTurn('s1', 't1')).toEqual([]);
      for (const [sessionId, turnId, msgId] of [
        ['s1', 't1', 'm2'],
        ['s1', 't1', 'm1'],
        ['s1', 't2', 'm3'],
        ['s2', 't1', 'm1'],
      ]) {
        await writerRepository.upsert({
          sessionId: sessionId!,
          turnId,
          message: {
            msg_id: msgId,
            role: 'assistant',
            text: `${sessionId}/${msgId}`,
            timestamp: 1,
          },
        });
      }
      expect((await repository.listTurn('s1', 't1')).map((m) => m.msg_id)).toEqual(['m2', 'm1']);
      expect((await repository.listTurn('s1', 't2')).map((m) => m.msg_id)).toEqual(['m3']);
      expect((await repository.get('s2', 'm1'))?.text).toBe('s2/m1');
      await writerRepository.upsert({
        sessionId: 's1',
        turnId: 't2',
        message: {
          msg_id: 'm1',
          role: 'assistant',
          text: 'updated',
          timestamp: 2,
        },
      });
      expect((await repository.get('s1', 'm1'))?.text).toBe('updated');
      expect((await repository.listTurn('s1', 't1')).map((m) => m.msg_id)).toEqual(['m2']);
      client.close();
      const reopened = createMessageRepository({ db: client.db });
      expect((await reopened.listTurn('s1', 't2')).map((m) => m.msg_id)).toEqual(['m1', 'm3']);
      writer.db.delete(messageRows).where(eq(messageRows.sessionId, 's1')).run();
      expect(await reopened.get('s1', 'm1')).toBeUndefined();
      expect(await reopened.listTurn('s1', 't2')).toEqual([]);
      expect(await reopened.get("s2' OR 1=1 --", 'm1')).toBeUndefined();
      expect(await reopened.listTurn('s2', "t1' OR 1=1 --")).toEqual([]);
    });
  });

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
  it('preserves baseline digest bytes and replay byte counts for Unicode and special values', () => {
    const sparse = new Array(12);
    sparse[2] = undefined;
    sparse[10] = '\ud800🙂';
    Object.defineProperty(sparse, 'extra', {
      value: '中文\udc00',
      enumerable: true,
    });
    // Golden values from the pre-optimization encoder, including its framing.
    const cases = [
      {
        value: {
          z: '中文🙂\ud800',
          a: [null, undefined, true, false, NaN, Infinity, -Infinity, -0, 0, 1.25],
          ['\ud800']: 'tail\udc00',
          ['__proto__']: { '10': true, '2': null },
        },
        fingerprint: 'f4961c05ea68951c93239df0af388afe47951d7e293f9982597bb9313723a1c8',
        bytes: 436,
      },
      {
        value: sparse,
        fingerprint: 'b29cce838437e6e8aee783feba4a57bc3c58edd363e5b8abd51525bd07bc1df8',
        bytes: 116,
      },
      {
        value: 'a'.repeat(8191) + '🙂中\ud800' + 'b'.repeat(16385) + '\udc00',
        fingerprint: 'b9a02642e610f3591d56337e788f7214c7d9ccbd51edf447bfd5539438b3c11f',
        bytes: 24603,
      },
    ];
    for (const { value, fingerprint, bytes } of cases) {
      const snapshot = captureSemanticSnapshot(value);
      expect(snapshot.fingerprint).toBe(fingerprint);
      expect(estimateSemanticValueSize(snapshot.value)).toBe(bytes);
    }
  });
  it('keeps exact size accounting when owned subtrees are reused and aliases repeat', () => {
    const body = captureSemanticSnapshot({ text: '中文🙂'.repeat(2048), parts: [-0, undefined] }).value;
    const expected = estimateSemanticValueSize(structuredClone(body));
    expect(estimateSemanticValueSize(body)).toBe(expected);
    expect(estimateSemanticValueSize(body)).toBe(expected);
    const wrapped = captureSemanticSnapshot({ a: body, b: body }).value;
    expect(estimateSemanticValueSize(wrapped)).toBe(estimateSemanticValueSize(structuredClone(wrapped)));
    const mutable = { nested: { text: 'before' } };
    const before = estimateSemanticValueSize(mutable);
    mutable.nested.text = 'after with a longer body';
    expect(estimateSemanticValueSize(mutable)).not.toBe(before);
    const shallow = Object.freeze({ nested: { text: 'a' } });
    estimateSemanticValueSize(shallow);
    shallow.nested.text = 'longer';
    expect(estimateSemanticValueSize(shallow)).toBe(estimateSemanticValueSize(structuredClone(shallow)));
  });
  it('preserves changed-parent aliases, own __proto__, empty objects and cycles during reuse', () => {
    const shared = { child: { text: 'same' } };
    const prior = captureSemanticSnapshot({ ['__proto__']: shared, first: shared, second: {}, tail: [1] }).value;
    const input = { ['__proto__']: shared, first: shared, second: {}, tail: [2] };
    const next = captureSemanticSnapshot(input, prior);
    expect(next.value).toEqual(structuredClone(input));
    expect(next.value['__proto__']).toBe(next.value.first);
    expect(next.value.first).toBe(prior.first);
    expect(next.value.second).toBe(prior.second);
    expect(next.fingerprint).toBe(captureSemanticSnapshot(input).fingerprint);
    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    expect(() => captureSemanticSnapshot(cyclic, captureSemanticSnapshot({ child: {} }).value)).toThrow('Cyclic');
  });
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
  it('shares unchanged plain descendants without changing values, fingerprints or byte accounting', () => {
    const before = captureSemanticSnapshot({ messages: [{ text: 'old', nested: [-0, undefined] }] });
    const input = { messages: [{ text: 'old', nested: [-0, undefined] }, { text: 'new', nested: [1] }] };
    const shared = captureSemanticSnapshot(input, before.value);
    const independent = captureSemanticSnapshot(input);
    expect(shared.value).toEqual(independent.value);
    expect(shared.fingerprint).toBe(independent.fingerprint);
    expect(estimateSemanticValueSize(shared.value)).toBe(estimateSemanticValueSize(independent.value));
    expect(shared.value.messages[0]).toBe(before.value.messages[0]);
    expect(shared.value.messages).not.toBe(before.value.messages);
    input.messages[0]!.text = 'edited';
    expect(shared.value.messages[0]!.text).toBe('old');
    const edited = captureSemanticSnapshot(input, shared.value);
    expect(edited.value.messages[0]).not.toBe(shared.value.messages[0]);
    expect(edited.value.messages[1]).toBe(shared.value.messages[1]);
  });
  it('preserves split and merged aliases when sharing a previous snapshot', () => {
    const alias = { text: 'same' };
    const prior = captureSemanticSnapshot({ a: alias, b: alias }).value;
    const split = captureSemanticSnapshot({ a: { text: 'same' }, b: { text: 'same' } }, prior).value;
    expect(split.a).not.toBe(split.b);
    const merged = captureSemanticSnapshot({ a: alias, b: alias }, split).value;
    expect(merged.a).toBe(merged.b);
    const mixed = captureSemanticSnapshot({ a: { text: 'same' }, b: prior.a }, prior).value;
    expect(mixed.a).not.toBe(mixed.b);
    expect(mixed.b).toBe(prior.a);
    const mixedFirst = captureSemanticSnapshot({ a: prior.a, b: { text: 'same' } }, prior).value;
    expect(mixedFirst.a).not.toBe(mixedFirst.b);
  });
  it('preserves key order, sparse arrays, negative zero and native accessor behavior during reuse', () => {
    const prior = captureSemanticSnapshot({ a: 1, b: 2 }).value;
    const reordered = captureSemanticSnapshot({ b: 2, a: 1 }, prior).value;
    expect(Object.keys(reordered)).toEqual(['b', 'a']);
    const sparse = new Array(3);
    sparse[2] = -0;
    const oldArray = captureSemanticSnapshot(sparse).value;
    const nextArray = captureSemanticSnapshot([undefined, undefined, 0], oldArray).value;
    expect(0 in nextArray).toBe(true);
    expect(Object.is(nextArray[2], -0)).toBe(false);
    expect(0 in oldArray).toBe(false);
    const getter = vi.fn(() => 1);
    expect(captureSemanticSnapshot({ get a() { return getter(); }, b: 2 }, prior).value).toEqual(prior);
    expect(getter).toHaveBeenCalledTimes(1);
    const trap = vi.fn();
    expect(() => captureSemanticSnapshot(new Proxy({}, { ownKeys: trap }), prior)).toThrow();
    expect(trap).not.toHaveBeenCalled();
    const unsafe = Object.freeze({ nested: { text: 'old' } });
    const snapshot = captureSemanticSnapshot({ nested: { text: 'old' } }, unsafe).value;
    unsafe.nested.text = 'changed';
    expect(snapshot.nested.text).toBe('old');
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

describe('incremental replay identities', () => {
  it('preserves semantic equality, ordering and special-value distinctions', () => {
    const values: unknown[] = [undefined, null, NaN, Infinity, -Infinity, -0, 0, '', [],
      Array(1), [undefined], {}, { a: undefined }, ['ab', 'c'], ['a', 'bc'],
      { b: 2, a: 1 }, { a: 1, b: 2 }, { text: '\ud800🙂中文' }, { text: '\ufffd🙂中文' }];
    const shared = { a: 'repeat' };
    values.push([shared, shared], [{ a: 'repeat' }, { a: 'repeat' }]);
    const snapshots = values.map(value => captureSemanticSnapshot(value));
    for (const a of snapshots) for (const b of snapshots) {
      expect(a.replayFingerprint === b.replayFingerprint).toBe(a.fingerprint === b.fingerprint);
    }
  });

  it('reuses owned children without masking caller mutations or changing byte budgets', () => {
    const raw = { body: '中文🙂'.repeat(4096), metadata: { version: 1 } };
    const old = captureSemanticSnapshot(raw);
    const before = old.replayFingerprint;
    const first = captureSemanticSnapshot({ messages: [old.value, old.value] });
    const second = captureSemanticSnapshot(structuredClone(first.value));
    expect(first.replayFingerprint).toBe(second.replayFingerprint);
    expect(estimateSemanticValueSize(first.value)).toBe(estimateSemanticValueSize(second.value));
    raw.metadata.version = 2;
    expect(old.replayFingerprint).toBe(before);
    expect(captureSemanticSnapshot(raw).replayFingerprint).not.toBe(before);
    const updated = captureSemanticSnapshot({ messages: [old.value, captureSemanticSnapshot(raw).value] });
    expect(updated.replayFingerprint).not.toBe(first.replayFingerprint);
  });
});

describe('ordered replay eviction', () => {
  function pending() {
    let resolve!: (value: number) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  const request = (identity: string, execute: () => Promise<number>, fingerprint = identity) => ({
    identity, fingerprint, execute, conflict: () => new Error('conflict'),
  });

  it('evicts by insertion order rather than completion order and keeps conflict tombstones', async () => {
    const registry = new SemanticReplayRegistry<number>(3, {
      maximumSettledBytes: 2, measureSettledBytes: value => value,
    });
    const a = pending(), b = pending(), c = pending();
    const pa = registry.run(request('a', () => a.promise));
    const pb = registry.run(request('b', () => b.promise));
    const pc = registry.run(request('c', () => c.promise));
    c.resolve(1); await pc;
    b.resolve(1); await pb;
    a.resolve(1); await pa;
    const execute = vi.fn(async () => 1);
    await expect(registry.run(request('a', execute))).rejects.toThrow('no longer retained');
    await expect(registry.run(request('a', execute, 'different'))).rejects.toThrow('conflict');
    expect(execute).not.toHaveBeenCalled();
    expect(registry.run(request('b', execute))).toBe(pb);
    expect(registry.run(request('c', execute))).toBe(pc);
    await registry.run(request('d', execute));
    await registry.run(request('a', execute));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('ignores a superseded settlement after synchronous execution re-entry', async () => {
    const registry = new SemanticReplayRegistry<number>(3, {
      maximumSettledBytes: 2, measureSettledBytes: value => value,
    });
    const inner = pending(), outer = pending();
    let innerExecution!: Promise<number>;
    const outerExecution = registry.run(request('a', () => {
      innerExecution = registry.run(request('a', () => inner.promise));
      return outer.promise;
    }));
    outer.resolve(1); await outerExecution;
    inner.resolve(10); await innerExecution;
    const execute = vi.fn(async () => 1);
    await expect(registry.run(request('a', execute))).resolves.toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('protects pending work, removes rejected entries, and permits an exact retry', async () => {
    const registry = new SemanticReplayRegistry<number>(1);
    const a = pending(), b = pending();
    const pa = registry.run(request('a', () => a.promise));
    const pb = registry.run(request('b', () => b.promise));
    b.resolve(2); await pb;
    const execute = vi.fn(async () => 3);
    expect(registry.run(request('a', execute))).toBe(pa);
    await expect(registry.run(request('b', execute))).resolves.toBe(3);
    a.reject(new Error('retryable'));
    await expect(pa).rejects.toThrow('retryable');
    await expect(registry.run(request('a', execute))).resolves.toBe(3);
    expect(execute).toHaveBeenCalledTimes(2);
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
  it('shares immutable messages across fresh provider snapshots while observing edits and replacement', async () => {
    let current = {
      revision: 'r1',
      messages: [{ role: 'user', timestamp: 1, content: 'old' }],
      identityVector: ['msg-1'],
    };
    const read = async () => structuredClone(current);
    const store = new DurableCanonicalHistoryStore({ read, readActive: read, append: read, replace: read });
    const first = await store.read('synthetic-session');
    current = { revision: 'r2', messages: [...current.messages, { role: 'user', timestamp: 2, content: 'new' }], identityVector: ['msg-1', 'msg-2'] };
    const second = await store.read('synthetic-session');
    expect(second.messages[0]).toBe(first.messages[0]);
    expect(second.messages).toHaveLength(2);
    current.messages[0]!.content = 'edited';
    const third = await store.read('synthetic-session');
    expect(third.messages[0]).not.toBe(second.messages[0]);
    expect(third.messages[1]).toBe(second.messages[1]);
    expect(second.messages[0]).toMatchObject({ content: 'old' });
    current = { revision: 'r3', messages: [], identityVector: [] };
    expect((await store.read('synthetic-session')).messages).toEqual([]);
    expect(first.messages).toHaveLength(1);
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

describe('owned decoded history rows', () => {
  async function withReaders(
    run: (path: string, reader: CanonicalHistoryJsonlDataSource) => Promise<void>,
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'mcode-owned-rows-'));
    const path = join(dir, 'messages.jsonl');
    try {
      await run(
        path,
        new CanonicalHistoryJsonlDataSource({
          activePath: path,
          reuseDecodedRecords: true,
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const row = (id: string, content: unknown = '中文🙂\ud800') => ({
    message_id: `msg-${id}`,
    turn_id: `turn-${id}`,
    message: { role: 'user', timestamp: 1, content },
  });
  const encode = (rows: unknown[]) => rows.map((value) => JSON.stringify(value)).join('\n') + '\n';

  it('reuses unchanged rows across append while matching uncached revisions', async () => {
    await withReaders(async (path, reader) => {
      const records = [row('a'), row('b', { '2': 'two', z: [-0, null, true], __proto__: null })];
      await writeFile(path, encode(records.slice(0, 1)));
      const first = await reader.readActiveStrict();
      const firstRevision = canonicalActiveHistoryRevision(first);
      await reader.append([records[1]!], first);
      const second = await reader.readActiveStrict();
      expect(second[0]).toBe(first[0]);
      const plain = await new CanonicalHistoryJsonlDataSource({
        activePath: path,
      }).readActiveStrict();
      expect(second).toEqual(plain);
      expect(canonicalActiveHistoryRevision(second)).toBe(canonicalActiveHistoryRevision(plain));
      expect(canonicalHistoryRevision(second)).toBe(canonicalHistoryRevision(plain));
      expect(canonicalActiveHistoryRevision(first)).toBe(firstRevision);
      expect(Object.isFrozen(second[1]!.message.content)).toBe(true);
    });
  });

  it('matches uncached UTF-8 replacement and CRLF decoding across appended rows', async () => {
    await withReaders(async (path, reader) => {
      const first = Buffer.from(JSON.stringify(row('a', '中文🙂X')) + '\r\n');
      first[first.indexOf(Buffer.from('X'))] = 0xff;
      await writeFile(path, first);
      const initial = await reader.readActiveStrict();
      const next = Buffer.concat([first, Buffer.from(JSON.stringify(row('b', '尾部🙂')))]);
      await writeFile(path, next);
      const cached = await reader.readActiveStrict();
      const plain = await new CanonicalHistoryJsonlDataSource({ activePath: path }).readActiveStrict();
      expect(cached[0]).toBe(initial[0]);
      expect(cached).toEqual(plain);
      expect(canonicalActiveHistoryRevision(cached)).toBe(canonicalActiveHistoryRevision(plain));
      expect(cached[0]!.message.content).toBe('中文🙂\ufffd');
    });
  });

  it('keeps canonical digests exact across growing, rewritten and revisited histories', async () => {
    await withReaders(async (path, reader) => {
      const snapshots: { records: readonly CanonicalHistoryEnvelope[]; revision: string }[] = [];
      let rows: ReturnType<typeof row>[] = [];
      for (let index = 0; index < 48; index++) {
        if (index % 11 === 0) rows = rows.slice(0, 2);
        if (index % 7 === 0 && rows[0]) rows[0] = row(`edited-${index}`, '\udc00中🙂');
        rows.push(row(String(index), `body-${index}:中文🙂\ud800`.repeat(100)));
        await writeFile(path, encode(rows));
        const records = index % 2 === 0
          ? await reader.readActiveStrict()
          : (await reader.readActiveWithBytes()).records;
        const revision = `sha256:${createHash('sha256')
          .update(canonicalJson(rows.map(decodeCanonicalHistoryEnvelope)), 'utf8')
          .digest('hex')}`;
        expect(canonicalActiveHistoryRevision(records)).toBe(revision);
        expect(canonicalHistoryRevision(records)).toBe(revision);
        snapshots.push({ records, revision });
      }
      for (const snapshot of snapshots.reverse()) {
        expect(canonicalHistoryRevision(snapshot.records)).toBe(snapshot.revision);
      }
    });
  });

  it('keeps private cached arrays immutable without exposing their state', async () => {
    await withReaders(async (path, reader) => {
      await writeFile(path, encode([row('a'), row('b')]));
      const first = await reader.readActiveStrict();
      expect(() => first.pop()).toThrow();
      expect(() => { first[0] = row('replacement'); }).toThrow();
      expect((await reader.readActiveStrict()).map(value => value.message_id)).toEqual(['msg-a', 'msg-b']);
    });
  });

  it('reparses an unterminated final line and preserves the absolute error line', async () => {
    await withReaders(async (path, reader) => {
      const text = JSON.stringify(row('a'));
      await writeFile(path, text);
      await reader.readActiveStrict();
      await writeFile(path, text + 'broken');
      await expect(reader.readActiveStrict()).rejects.toThrow('line 1');
      await writeFile(path, text + '\n' + JSON.stringify(row('b')) + '\n');
      await reader.readActiveStrict();
      await writeFile(path, text + '\n' + JSON.stringify(row('b')) + '\n{broken}\n');
      await expect(reader.readActiveStrict()).rejects.toThrow('line 3');
    });
  });

  it('keeps a reusable complete prefix when the history exceeds the cache budget', async () => {
    await withReaders(async (path, reader) => {
      const entries = [row('a', 'a'.repeat(2 * 1024 * 1024)), row('b', 'b'.repeat(2 * 1024 * 1024)), row('c')];
      await writeFile(path, encode(entries));
      const first = await reader.readActiveStrict();
      const next = await reader.readActiveStrict();
      expect(next[0]).toBe(first[0]);
      expect(next).toEqual(first);
      await writeFile(path, encode([entries[0], entries[1], row('d')]));
      expect((await reader.readActiveStrict())[2]!.message_id).toBe('msg-d');
    });
  });

  it('observes same-length edits, truncation, deletion and recreation', async () => {
    await withReaders(async (path, reader) => {
      await writeFile(path, encode([row('a', 'first')]));
      const first = await reader.readActiveStrict();
      const revision = canonicalActiveHistoryRevision(first);
      await writeFile(path, encode([row('a', 'other')]));
      const edited = await reader.readActiveStrict();
      expect(edited[0]!.message.content).toBe('other');
      expect(canonicalActiveHistoryRevision(edited)).not.toBe(revision);
      await writeFile(path, '');
      expect(await reader.readActiveStrict()).toEqual([]);
      await rm(path);
      await expect(reader.readActiveStrict()).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await writeFile(path, encode([row('b')]));
      expect((await reader.readActiveStrict())[0]!.message_id).toBe('msg-b');
    });
  });

  it('still rejects corrupt and duplicate rows after warming the cache', async () => {
    await withReaders(async (path, reader) => {
      const valid = row('a');
      await writeFile(path, encode([valid]));
      await reader.readActiveStrict();
      await writeFile(path, encode([valid, valid]));
      await expect(reader.readActiveStrict()).rejects.toThrow('duplicate');
      await writeFile(path, encode([valid]) + '{"message_id":"private-payload"\n');
      await expect(reader.readActiveStrict()).rejects.toThrow('invalid JSON');
      await writeFile(path, encode([valid]) + '\n');
      await expect(reader.readActiveStrict()).rejects.toThrow('blank line');
      await writeFile(path, encode([{ ...valid, message: { ...valid.message, timestamp: null } }]));
      await expect(reader.readActiveStrict()).rejects.toThrow('timestamp');
    });
  });

  it('checks pending and settled sequence rules on every cached read', async () => {
    await withReaders(async (path, reader) => {
      const pending = {
        message_id: 'msg-assistant',
        turn_id: 'turn-a',
        message: {
          role: 'assistant',
          timestamp: 1,
          content: [
            {
              type: 'toolCall',
              id: 'call-a',
              name: 'bash',
              arguments: { command: 'pwd' },
            },
          ],
        },
      };
      await writeFile(path, encode([pending]));
      const records = await reader.readActiveStrict();
      canonicalActiveHistoryRevision(records);
      const inspection = inspectCanonicalHistorySequence(records);
      if (inspection.status === 'pending-tool-results') {
        (inspection.pendingToolCallIds as string[]).pop();
      }
      expect(inspectCanonicalHistorySequence(records)).toMatchObject({ pendingToolCallIds: ['call-a'] });
      expect(() => canonicalHistoryRevision(records)).toThrow('tool results');
      await expect(reader.readStrict()).rejects.toThrow('tool results');
      expect((await reader.readActiveStrict())[0]).toBe(records[0]);
      await writeFile(path, encode([pending, row('b')]));
      await expect(reader.readActiveStrict()).rejects.toThrow();
    });
  });

  it('does not trust caller-frozen records or leak mutable state from ordinary readers', async () => {
    await withReaders(async (path) => {
      const input = Object.freeze(row('a', { nested: ['original'] }));
      const externallyFrozenArray = Object.freeze([input]);
      const before = canonicalHistoryRevision(externallyFrozenArray);
      (input.message.content as { nested: string[] }).nested[0] = 'changed';
      expect(canonicalHistoryRevision(externallyFrozenArray)).not.toBe(before);
      await writeFile(path, encode([input]));
      const ordinary = new CanonicalHistoryJsonlDataSource({
        activePath: path,
      });
      const first = await ordinary.readActiveStrict();
      (first[0]!.message.content as { nested: string[] }).nested[0] = 'caller edit';
      expect((await ordinary.readActiveStrict())[0]!.message.content).toEqual({
        nested: ['changed'],
      });
    });
  });

  it('keeps default provider snapshots mutable and detached from its private rows', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-owned-provider-'));
    try {
      const session: SessionRecord = {
        sessionId: 'owned-session',
        agentName: 'test',
        workspaceDir: dataDir,
        runtime: 'pi-agent',
        sessionType: 'root',
        sessionKind: 'conversation',
        archived: false,
        status: 'idle',
        createdAtMs: 0,
        updatedAtMs: 0,
        historyRelativeDir: utcSessionHistoryRelativeDir('owned-session', 0),
      };
      const provider = createSessionSystemCanonicalHistoryProvider({
        dataDir,
        sessions: { get: async () => session },
      });
      const input = {
        role: 'user',
        timestamp: 1,
        content: [{ type: 'text', text: 'original' }],
      };
      const committed = await provider.append({
        sessionId: session.sessionId,
        turnId: 't1',
        reason: 'messageDelta',
        messages: [input],
        operation: { id: 'a1', kind: 'append' },
      });
      input.content[0]!.text = 'caller input edit';
      (committed.messages[0] as typeof input).content[0]!.text = 'caller output edit';
      const next = await provider.readActive(session.sessionId);
      expect((next.messages[0] as typeof input).content[0]!.text).toBe('original');
      expect(next.revision).toBe(committed.revision);
      const path = resolveSessionHistoryPaths(dataDir, session).messages;
      await writeFile(path, encode([row('external', 'outside')]));
      expect((await provider.readActive(session.sessionId)).messages[0]).toMatchObject({
        content: 'outside',
      });
      await writeFile(path, '{bad}\n');
      await expect(provider.readActive(session.sessionId)).rejects.toThrow();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});


describe('internal history snapshot handoff', () => {
  async function fixture(run: (input: {
    provider: ReturnType<typeof createSessionSystemCanonicalHistoryProvider>;
    session: SessionRecord;
    dataDir: string;
  }) => Promise<void>) {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-history-handoff-'));
    const session: SessionRecord = {
      sessionId: 'handoff', agentName: 'test', workspaceDir: dataDir,
      runtime: 'pi-agent', sessionType: 'root', sessionKind: 'conversation',
      archived: false, status: 'idle', createdAtMs: 0, updatedAtMs: 0,
      historyRelativeDir: utcSessionHistoryRelativeDir('handoff', 0),
    };
    try {
      await run({ dataDir, session, provider: createSessionSystemCanonicalHistoryProvider({
        dataDir, sessions: { get: async () => session },
      }) });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  it('reuses frozen messages only in the internal view and keeps ordinary callers isolated', async () => {
    await fixture(async ({ provider, session, dataDir }) => {
      const internal = provider.withSnapshotTransform!(snapshot => snapshot);
      const change = (id: string, text: string) => ({
        sessionId: session.sessionId, turnId: id, reason: 'messageDelta' as const,
        operation: { id, kind: 'append' },
        messages: [{ role: 'user', timestamp: 1, content: [{ type: 'text', text }] }],
      });
      const input = change('one', 'first');
      const first = await internal.append(input);
      input.messages[0]!.content[0]!.text = 'caller edit';
      const second = await internal.append(change('two', 'second'));
      expect(second.messages[0]).toBe(first.messages[0]);
      expect(first.messages).toHaveLength(1);
      expect(Object.isFrozen(first.messages[0])).toBe(true);
      const message = first.messages[0] as typeof input.messages[number];
      expect(Object.isFrozen(message.content[0])).toBe(true);
      expect(message.content[0]!.text).toBe('first');
      const ordinary = await provider.readActive(session.sessionId);
      expect(ordinary).toEqual(second);
      expect(ordinary.messages[0]).not.toBe(first.messages[0]);
      (ordinary.messages[0] as typeof message).content[0]!.text = 'ordinary caller edit';
      const inspected = await internal.inspectActive(session.sessionId);
      (inspected.messages[0] as typeof message).content[0]!.text = 'inspection edit';
      expect(await internal.readActive(session.sessionId)).toEqual(second);
      const path = resolveSessionHistoryPaths(dataDir, session).messages;
      const bytes = await readFile(path, 'utf8');
      await writeFile(path, bytes.replace('first', 'other'));
      const rewritten = await internal.readActive(session.sessionId);
      expect((rewritten.messages[0] as typeof message).content[0]!.text).toBe('other');
      expect(rewritten.messages[0]).not.toBe(first.messages[0]);
      expect(message.content[0]!.text).toBe('first');
      await writeFile(path, '{bad}\n');
      await expect(internal.readActive(session.sessionId)).rejects.toThrow();
      await provider.delete(session.sessionId);
      expect((await internal.readActive(session.sessionId)).messages).toEqual([]);
      const recreated = await internal.append(change('three', 'new'));
      expect(recreated.messages).toHaveLength(1);
      expect(recreated.messages[0]).not.toBe(first.messages[0]);
    });
  });

  it('preserves pending-tail recovery, compaction identities and snapshot generation', async () => {
    await fixture(async ({ provider, session }) => {
      const internal = provider.withSnapshotTransform!(snapshot => captureSemanticSnapshot(snapshot).value);
      const active = await internal.append({
        sessionId: session.sessionId, turnId: 'pending', reason: 'messageDelta',
        operation: { id: 'pending', kind: 'append' },
        messages: [
          { role: 'user', timestamp: 1, content: 'question' },
          { role: 'assistant', timestamp: 2, content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
          ] },
        ],
      });
      expect(active.messages).toHaveLength(2);
      expect(await internal.readActive(session.sessionId)).toEqual(active);
      const settled = await internal.read(session.sessionId);
      expect(settled.messages).not.toEqual(active.messages);
      expect(await provider.read(session.sessionId)).toEqual(settled);
      const compacted = await internal.compact({
        sessionId: session.sessionId, turnId: 'compact', reason: 'replaceMessages',
        operation: { id: 'compact', kind: 'compaction' }, compactionId: 'compact',
        method: 'llm_checkpoint', summary: 'summary',
        messages: [{ role: 'compactionSummary', summary: 'summary' }],
      });
      expect(compacted.generation).toBe(1);
      const plain = await provider.readActive(session.sessionId);
      expect(compacted.messages).toEqual(plain.messages);
      expect(compacted.identityVector).toEqual(plain.identityVector);
      expect(compacted.revision).toBe(plain.revision);
      expect(Object.isFrozen(compacted.messages)).toBe(true);
      expect((await internal.readActive(session.sessionId)).messages).toEqual(plain.messages);
      expect(active.messages).toHaveLength(2);
    });
  });

  it('keeps injected adapters outside the immutable handoff', async () => {
    await fixture(async ({ dataDir, session }) => {
      const provider = createSessionSystemCanonicalHistoryProvider({
        dataDir, sessions: { get: async () => session },
        files: createCanonicalHistoryFileAdapter(),
      });
      expect(provider.withSnapshotTransform).toBeUndefined();
    });
  });
});

describe('incremental history index scanning', () => {
  const row = (id: string, content = '中文🙂') => ({
    message_id: `msg-user-v1-${id}`, turn_id: `turn-${id}`,
    message: { role: 'user', content, timestamp: 1 },
  });
  const encode = (rows: unknown[]) => rows.map(value => JSON.stringify(value)).join('\n') + '\n';
  async function fixture(run: (input: {
    paths: import('../packages/local-runtime-v2/src/service/session-system/messages/history/mutation/canonical-history-scanner.js').CanonicalHistoryScannerPaths;
    compare: () => Promise<Awaited<ReturnType<typeof scanCanonicalHistoryArtifacts>>>;
  }) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'mcode-index-scan-'));
    const paths = { activePath: join(dir, 'messages.jsonl'), snapshotsPath: join(dir, 'snapshots'), sessionId: 's1' };
    const scan = createCanonicalHistoryScanner();
    const files = createCanonicalHistoryFileAdapter({ reuseDecodedRecords: true });
    try {
      await mkdir(paths.snapshotsPath);
      await run({ paths, compare: async () => {
        const actual = await scan(paths, files);
        expect(actual).toEqual(await scanCanonicalHistoryArtifacts(paths));
        return actual;
      }});
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  it('matches full scanning across append, unchanged reads and new external user rows', async () => {
    await fixture(async ({paths, compare}) => {
      const rows = [row('a')];
      await writeFile(paths.activePath, encode(rows));
      const first = await compare();
      for (let i = 0; i < 20; i++) {
        rows.push(row(String(i), 'x'.repeat(4096)));
        await writeFile(paths.activePath, encode(rows));
        expect((await compare()).locators).toHaveLength(rows.length);
        await compare();
      }
      expect(first.locators).toHaveLength(1);
    });
  });
  it('rebuilds positions after same-length changes, truncation and recreation', async () => {
    await fixture(async ({paths, compare}) => {
      await writeFile(paths.activePath, encode([row('a', 'aaa'), row('b', 'bbb')]));
      await compare();
      await writeFile(paths.activePath, encode([row('z', 'zzz'), row('b', 'bbb')]));
      expect((await compare()).locators[0]?.messageId).toBe('msg-user-v1-z');
      await writeFile(paths.activePath, encode([row('c')]));
      await compare();
      await rm(paths.activePath);
      await expect(compare()).rejects.toThrow();
      await writeFile(paths.activePath, encode([row('a'), row('b')]));
      await compare();
    });
  });
  it('matches UTF-8 replacement offsets, CRLF, whitespace and unterminated tails', async () => {
    await fixture(async ({paths, compare}) => {
      const first = Buffer.from('  ' + JSON.stringify(row('a', 'X中文🙂')) + ' \r\n');
      first[first.indexOf('X')] = 0xff;
      await writeFile(paths.activePath, first);
      await compare();
      const second = Buffer.from(JSON.stringify(row('b')));
      await writeFile(paths.activePath, Buffer.concat([first, second]));
      await compare();
      await writeFile(paths.activePath, Buffer.concat([first, second, Buffer.from('\n' + encode([row('c')]))]));
      await compare();
    });
  });
  it('keeps full validation after cache hits and rejects duplicate external identities', async () => {
    await fixture(async ({paths, compare}) => {
      await writeFile(paths.activePath, encode([row('a')]));
      await compare();
      await writeFile(paths.activePath, encode([row('a'), row('a')]));
      await expect(compare()).rejects.toThrow();
      await writeFile(paths.activePath, '{invalid}\n');
      await expect(compare()).rejects.toThrow();
      await writeFile(paths.activePath, encode([row('a')]));
      await compare();
    });
  });
  it('falls back beyond the retained byte budget without changing offsets', async () => {
    await fixture(async ({paths, compare}) => {
      const rows = [row('a', 'x'.repeat(4 * 1024 * 1024)), row('b')];
      await writeFile(paths.activePath, encode(rows));
      await compare();
      rows.push(row('c'));
      await writeFile(paths.activePath, encode(rows));
      await compare();
    });
  });
  it('rechecks fresh bytes when history changes after the provider read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcode-index-race-'));
    const paths = { activePath: join(dir, 'messages.jsonl'), snapshotsPath: join(dir, 'snapshots'), sessionId: 's1' };
    const files = createCanonicalHistoryFileAdapter({ reuseDecodedRecords: true });
    const scan = createCanonicalHistoryScanner();
    try {
      await writeFile(paths.activePath, encode([row('a')]));
      await files.readActiveStrict(paths.activePath);
      await scan(paths, files);
      await files.readActiveStrict(paths.activePath);
      await writeFile(paths.activePath, '{invalid}\n');
      await expect(scan(paths, files)).rejects.toThrow('malformed-jsonl');
      await writeFile(paths.activePath, encode([row('z')]));
      expect((await scan(paths, files)).locators[0]?.messageId).toBe('msg-user-v1-z');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('continues checking snapshot revisions, lineage and symlinks after warm scans', async () => {
    await fixture(async ({paths, compare}) => {
      const parent = [row('a')];
      const parentPath = join(paths.snapshotsPath, 'g000000000000--compact.jsonl');
      await writeFile(parentPath, encode(parent));
      const active = [{ ...row('a'), history_artifact: {
        schemaVersion: 1, generation: 1, producedBy: 'llm_checkpoint',
        parentSnapshot: { generation: 0, compactionId: 'compact', revision: canonicalHistoryRevision(parent) },
      } }, row('b')];
      await writeFile(paths.activePath, encode(active));
      await compare();
      await compare();
      await writeFile(parentPath, encode([row('a', 'modified')]));
      await expect(compare()).rejects.toThrow('artifact-revision-mismatch');
      await writeFile(parentPath, encode(parent));
      await compare();
      const original = await readFile(parentPath);
      await rm(parentPath);
      await writeFile(join(paths.snapshotsPath, 'target'), original);
      await symlink('target', parentPath);
      await expect(compare()).rejects.toThrow('unsafe-artifact');
    });
  });
});
