import { parentPort } from 'node:worker_threads';

import { settleInBackground } from '../../../infra/async/settle.js';
import { runBrowserProgram } from './program-runtime.js';
import type {
  BrowserProgramInboundMessage,
  BrowserProgramOutboundMessage,
  BrowserProgramStartMessage,
} from './worker-protocol.js';

/**
 * Worker entry of Browser programs: one program per Worker. The host ends the
 * Worker when the program is done or a limit is reached, so nothing here has
 * to clean up after a stop.
 */
if (!parentPort) throw new Error('Browser program Worker requires a parent MessagePort.');

const port = parentPort;
const replies = new Map<number, (resultJson: string) => void>();
let nextOp = 0;
let started = false;
let opRoundTripMs = 0;

function post(message: BrowserProgramOutboundMessage): void {
  port.postMessage(message);
}

async function start(message: BrowserProgramStartMessage): Promise<void> {
  let disposeFailure: string | undefined;
  const result = await runBrowserProgram({
    code: message.code,
    ...(message.initialStateJson === undefined
      ? {}
      : { initialStateJson: message.initialStateJson }),
    maxHeapBytes: message.maxHeapBytes,
    deadlineAt: message.deadlineAt,
    onConsole: (line) => post({ type: 'console', line }),
    onDisposeFailed: (failure) => {
      disposeFailure = failure;
    },
    callOp: (opJson) =>
      new Promise<string>((resolve) => {
        nextOp += 1;
        const id = nextOp;
        const sentAt = performance.now();
        replies.set(id, (resultJson) => {
          opRoundTripMs += performance.now() - sentAt;
          resolve(resultJson);
        });
        post({ type: 'op', id, opJson });
      }),
  });
  const reported = disposeFailure === undefined ? {} : { disposeFailure };
  post(
    result.ok
      ? {
          type: 'done',
          ok: true,
          ...(result.valueJson === undefined ? {} : { valueJson: result.valueJson }),
          state: result.state,
          opRoundTripMs,
          ...reported,
        }
      : {
          type: 'done',
          ok: false,
          error: result.error,
          ...(result.state ? { state: result.state } : {}),
          opRoundTripMs,
          ...reported,
        },
  );
}

/** Every start ends in exactly one `done`, also when the runtime itself fails. */
async function startOrReport(message: BrowserProgramStartMessage): Promise<void> {
  try {
    await start(message);
  } catch (error) {
    post({
      type: 'done',
      ok: false,
      error: {
        kind: 'guest',
        name: 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
      opRoundTripMs,
    });
  }
}

port.on('message', (message: BrowserProgramInboundMessage) => {
  if (message.type === 'start') {
    if (started) return;
    started = true;
    settleInBackground(startOrReport(message));
    return;
  }
  const reply = replies.get(message.id);
  if (!reply) return;
  replies.delete(message.id);
  reply(message.resultJson);
});
