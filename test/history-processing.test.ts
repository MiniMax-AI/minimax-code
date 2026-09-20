import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IncrementalSha256 } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/incremental-sha256.js';
import { captureSemanticSnapshot } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/semantic-identity.js';
import { DurableCanonicalHistoryStore } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/durable-canonical-history-store.js';
import type { CanonicalHistoryChange } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/contracts.js';
import { BpeTokenEstimator } from '../packages/agent-modules/context-manager/src/token-estimator.js';
import { createSessionSystemCanonicalHistoryProvider } from '../packages/local-runtime-v2/src/service/session-system/messages/history/canonical-history-provider.js';
import { createCanonicalHistoryFileAdapter } from '../packages/local-runtime-v2/src/service/session-system/sessions/representation/canonical-history.js';
import {
  resolveSessionHistoryPaths,
  utcSessionHistoryRelativeDir,
} from '../packages/local-runtime-v2/src/service/session-system/messages/history/session-history-paths.js';
import type { SessionRecord } from '../packages/local-runtime-v2/src/service/session-system/sessions/repo/contract.js';

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
      expect(wrapped.value.history).not.toBe(snapshot.value.messages);
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
        return { input: getterFirst ? { nested, shared } : { shared, nested }, getter };
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
    const snapshot = captureSemanticSnapshot({ shared, nested: new Container() });
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
  it('bounds retained text independently of entry count', () => {
    const encode = vi.fn(() => [1]);
    const estimator = new BpeTokenEstimator(encode);
    const first = 'a '.repeat(300_000);
    const second = 'b '.repeat(300_000);
    estimator.estimateTextTokens(first);
    estimator.estimateTextTokens(second);
    estimator.estimateTextTokens(first);
    expect(encode).toHaveBeenCalledTimes(3);
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
