import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { StdinBuffer } from '../../src/tui/engine/public.js';

interface InputPipe {
  buffer: StdinBuffer;
  emitted: string[];
  write: (data: string) => void;
  received: (byteCount: number) => Promise<void>;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function blockEventLoop(ms: number): void {
  const blockedUntil = Date.now() + ms;
  while (Date.now() < blockedUntil) {
    // Simulates a synchronous render that keeps the event loop busy.
  }
}

/** Feeds a StdinBuffer from a real socket so bytes can queue in the kernel while the loop is blocked. */
async function createInputPipe(): Promise<InputPipe> {
  const buffer = new StdinBuffer({ timeout: 10, escapeTimeout: 10 });
  const emitted: string[] = [];
  buffer.on('data', (sequence) => emitted.push(sequence));

  let receivedBytes = 0;
  let waiters: Array<{ byteCount: number; resolve: () => void }> = [];
  const server: Server = createServer();
  const serverSocket = new Promise<Socket>((resolve) => server.once('connection', resolve));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  const client = createConnection(address.port, '127.0.0.1');
  await new Promise<void>((resolve) => client.once('connect', resolve));
  const input = await serverSocket;
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer.process(chunk);
    receivedBytes += Buffer.byteLength(chunk);
    waiters = waiters.filter((waiter) => {
      if (receivedBytes < waiter.byteCount) return true;
      waiter.resolve();
      return false;
    });
  });

  cleanups.push(() => {
    buffer.destroy();
    client.destroy();
    input.destroy();
    server.close();
  });

  return {
    buffer,
    emitted,
    write: (data) => {
      client.write(data);
    },
    received: (byteCount) =>
      new Promise((resolve) => {
        if (receivedBytes >= byteCount) resolve();
        else waiters.push({ byteCount, resolve });
      }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('StdinBuffer when a render blocks the event loop', () => {
  it('reassembles a mouse report whose remainder was queued during the block', async () => {
    const pipe = await createInputPipe();
    const first = '\x1b[<35;42';
    pipe.write(first);
    await pipe.received(first.length);

    pipe.write(';24M');
    blockEventLoop(40);
    await pipe.received(first.length + 4);
    await settle();

    expect(pipe.emitted).toEqual(['\x1b[<35;42;24M']);
  });

  it('does not turn a queued mouse report into Escape followed by typed text', async () => {
    const pipe = await createInputPipe();
    pipe.write('\x1b');
    await pipe.received(1);

    pipe.write('[<35;42;24M');
    blockEventLoop(40);
    await pipe.received(12);
    await settle();

    expect(pipe.emitted).toEqual(['\x1b[<35;42;24M']);
  });

  it('still treats ESC as Escape when the next byte arrives after the timeout', async () => {
    const pipe = await createInputPipe();
    pipe.write('\x1b');
    await pipe.received(1);
    await settle();

    pipe.write('x');
    await pipe.received(2);

    expect(pipe.emitted).toEqual(['\x1b', 'x']);
  });
});
