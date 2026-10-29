import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MCodeAbortError,
  MCodeProtocolError,
  MCodeVersionError,
  type ThreadEvent,
} from '../src/index.js';
import { fakeClient, fixture, fixtureEvents, tempDir } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

async function collect(events: AsyncIterable<ThreadEvent>): Promise<ThreadEvent[]> {
  const result: ThreadEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('thread.runStreamed', () => {
  it('yields CLI events in order and drops identical repeated snapshot updates', async () => {
    const mcode = fakeClient({ FAKE_MCODE_FIXTURE: fixture('success-tools') });
    const thread = mcode.startThread();

    const { events } = await thread.runStreamed('go');
    const received = await collect(events);

    const recorded = fixtureEvents('success-tools');
    const expected = recorded
      .map((event) => event.sequence as number)
      .filter((sequence) => ![7, 10, 20, 21].includes(sequence));
    expect(received.map((event) => event.sequence)).toEqual(expected);
    expect(received[0]).toEqual(recorded[0]);
    expect(received.at(-1)?.type).toBe('exec.completed');
    expect(thread.id).toBe('mvs_2bab54bd1f17409e968db62f8ed2784a');
  });

  it('keeps repeated text deltas, which are content rather than duplicates', async () => {
    const dir = tempDir();
    const base = { schemaVersion: 1, runId: 'r', sessionId: 's', turnId: 't', timestampMs: 1 };
    const item = { id: 'm:message', type: 'agent_message', contentDelta: 'ha' };
    const lines = [
      { ...base, sequence: 1, type: 'item.started', item },
      { ...base, sequence: 2, type: 'item.updated', item },
      {
        ...base,
        sequence: 3,
        type: 'item.completed',
        item: { id: 'm:message', type: 'agent_message', content: 'haha' },
      },
      { ...base, sequence: 4, type: 'turn.completed', durationMs: 1 },
      {
        ...base,
        sequence: 5,
        type: 'exec.completed',
        result: {
          ...base,
          type: 'exec.result',
          status: 'succeeded',
          output: 'haha',
          durationMs: 1,
        },
      },
    ];
    const path = `${dir}/deltas.jsonl`;
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));

    const { events } = await fakeClient({ FAKE_MCODE_FIXTURE: path })
      .startThread()
      .runStreamed('x');
    expect((await collect(events)).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('delivers turn.failed as an ordinary event without throwing', async () => {
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('failed-upstream'),
      FAKE_MCODE_EXIT: '4',
    });

    const { events } = await mcode.startThread().runStreamed('go');
    const types = (await collect(events)).map((event) => event.type);

    expect(types).toEqual([
      'exec.started',
      'session.started',
      'turn.started',
      'turn.failed',
      'exec.completed',
    ]);
  });

  it('throws MCodeProtocolError for a non-JSON stdout line after delivering earlier events', async () => {
    const path = `${tempDir()}/broken.jsonl`;
    const lines = readFileSync(fixture('success-tools'), 'utf8').split('\n');
    writeFileSync(
      path,
      [...lines.slice(0, 2), 'Update available: run npm i -g', ...lines.slice(2)].join('\n'),
    );

    const thread = fakeClient({ FAKE_MCODE_FIXTURE: path }).startThread();
    const { events } = await thread.runStreamed('go');
    const received: ThreadEvent[] = [];
    const error = await (async () => {
      for await (const event of events) received.push(event);
    })().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCodeProtocolError);
    expect((error as Error).message).toContain('stdout line 3');
    expect(received.map((event) => event.type)).toEqual(['exec.started', 'session.started']);
    expect(thread.id).toBe('mvs_2bab54bd1f17409e968db62f8ed2784a');
  });

  it('throws MCodeVersionError for an unsupported schemaVersion', async () => {
    const dir = tempDir();
    const path = `${dir}/v2.jsonl`;
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 2, sequence: 1, type: 'exec.started', sessionId: 's' })}\n`,
    );

    const { events } = await fakeClient({ FAKE_MCODE_FIXTURE: path })
      .startThread()
      .runStreamed('go');

    await expect(collect(events)).rejects.toBeInstanceOf(MCodeVersionError);
  });

  it('passes unknown event types through unchanged', async () => {
    const dir = tempDir();
    const path = `${dir}/unknown.jsonl`;
    const lines = readFileSync(fixture('resumed'), 'utf8').split('\n').filter(Boolean);
    const extra = JSON.stringify({
      schemaVersion: 1,
      sequence: 99,
      timestampMs: 1,
      runId: 'r',
      sessionId: 'mvs_2bab54bd1f17409e968db62f8ed2784a',
      turnId: 't',
      type: 'plan.updated',
      plan: ['a'],
    });
    writeFileSync(path, [lines[0], extra, ...lines.slice(1)].join('\n'));

    const { events } = await fakeClient({ FAKE_MCODE_FIXTURE: path })
      .startThread()
      .runStreamed('go');
    const received = await collect(events);

    expect(received[1]).toMatchObject({ type: 'plan.updated', plan: ['a'] });
  });

  posixOnly('delivers a cancelled Turn as events when the CLI exits gracefully', async () => {
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('cancelled'),
      FAKE_MCODE_MODE: 'wait-sigint',
      FAKE_MCODE_SPLIT: '9',
    });
    const controller = new AbortController();
    const { events } = await mcode
      .startThread()
      .runStreamed('sleep', { signal: controller.signal });

    const types: string[] = [];
    for await (const event of events) {
      types.push(event.type);
      if (event.type === 'item.updated' && event.item.toolCall?.status === 1) controller.abort();
    }

    expect(types.slice(-2)).toEqual(['turn.failed', 'exec.completed']);
  });

  posixOnly('cancels the CLI when the consumer stops iterating early', async () => {
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('cancelled'),
      FAKE_MCODE_MODE: 'wait-sigint',
      FAKE_MCODE_SPLIT: '3',
    });
    const thread = mcode.startThread();
    const { events } = await thread.runStreamed('sleep');

    for await (const event of events) {
      if (event.type === 'turn.started') break;
    }

    // The interrupted process exits and the Thread becomes available again.
    const busy = (): boolean => (thread as unknown as { busy: boolean }).busy;
    const deadline = Date.now() + 5_000;
    while (busy() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(busy()).toBe(false);
  });

  posixOnly('throws AbortError when the CLI is killed before reporting a result', async () => {
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('cancelled'),
      FAKE_MCODE_MODE: 'hang',
      FAKE_MCODE_SPLIT: '3',
    });
    const controller = new AbortController();
    const { events } = await mcode
      .startThread()
      .runStreamed('sleep', { signal: controller.signal });

    const error = await (async () => {
      for await (const event of events) {
        if (event.type === 'turn.started') controller.abort();
      }
    })().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCodeAbortError);
    expect((error as MCodeAbortError).signal).toBe('SIGTERM');
  });
});
