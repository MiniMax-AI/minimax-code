import { parentPort } from 'node:worker_threads';

import type {
  PtcGuestInboundMessage,
  PtcGuestOutboundMessage,
  PtcGuestToolResultMessage,
} from '../../execution/ptc/contracts.js';
import { createPtcConsoleSink, executePtcQuickJsProgram } from './quickjs-runtime.js';

if (!parentPort) throw new Error('PTC QuickJS worker requires a parent MessagePort.');

let controller: AbortController | undefined;
let activeProgram: Promise<void> | undefined;
const replies = new Map<string, { resolve(value: string): void; reject(reason: unknown): void }>();

parentPort.on('message', (message: PtcGuestInboundMessage) => {
  if (message.type === 'start') {
    if (controller || activeProgram) return;
    controller = new AbortController();
    activeProgram = run(message, controller);
    return;
  }
  if (message.type === 'tool_result') {
    settleReply(message);
    return;
  }
  controller?.abort(message.reason);
  rejectReplies(new Error(`PTC stopped: ${message.reason}`));
});

post({ type: 'ready' });

async function run(
  message: Extract<PtcGuestInboundMessage, { readonly type: 'start' }>,
  signalOwner: AbortController,
): Promise<void> {
  try {
    await runProgram(message, signalOwner);
  } catch (error) {
    post({
      type: 'failed',
      error: {
        code: 'worker_error',
        message: error instanceof Error ? error.message : String(error),
      },
      pendingRequestIds: [...replies.keys()],
    });
  } finally {
    activeProgram = undefined;
  }
}

async function runProgram(
  message: Extract<PtcGuestInboundMessage, { readonly type: 'start' }>,
  signalOwner: AbortController,
): Promise<void> {
  const consoleSink = createPtcConsoleSink(message.limits.maxConsoleBytes, (text, truncated) =>
    post({ type: 'console', text, ...(truncated ? { truncated: true } : {}) }),
  );
  const result = await executePtcQuickJsProgram({
    code: message.code,
    tools: message.toolNames.map((name) => ({ name })),
    maxHeapBytes: message.limits.maxHeapBytes,
    maxComputeMs: message.limits.maxComputeMs,
    maxToolCalls: message.limits.maxToolCalls,
    signal: signalOwner.signal,
    onActivityChange: (active) => post({ type: 'activity', active }),
    onLimitExceeded: (budget) => post({ type: 'limit_rejected', budget }),
    onConsole: consoleSink,
    callTool: (request) =>
      new Promise<string>((resolve, reject) => {
        replies.set(request.requestId, { resolve, reject });
        post({ type: 'tool_call', ...request });
      }),
  });
  if (result.ok) {
    post({
      type: 'completed',
      valueJson: result.valueJson,
      pendingRequestIds: result.pendingRequestIds,
      droppedUndefinedPaths: result.droppedUndefinedPaths,
      droppedUndefinedCount: result.droppedUndefinedCount,
    });
  } else {
    post({ type: 'failed', error: result.error, pendingRequestIds: result.pendingRequestIds });
  }
}

function settleReply(message: PtcGuestToolResultMessage): void {
  const reply = replies.get(message.requestId);
  if (!reply) return;
  replies.delete(message.requestId);
  if (message.resultJson !== undefined) {
    reply.resolve(message.resultJson);
    post({ type: 'tool_consumed', requestId: message.requestId });
  } else {
    reply.reject(
      new PtcWorkerToolError(
        message.error ?? { code: 'guest_error', message: 'PTC tool call failed.' },
      ),
    );
  }
}

class PtcWorkerToolError extends Error {
  constructor(readonly failure: NonNullable<PtcGuestToolResultMessage['error']>) {
    super(failure.message);
    this.name = 'PtcWorkerToolError';
  }
}

function rejectReplies(reason: unknown): void {
  for (const reply of replies.values()) reply.reject(reason);
  replies.clear();
}

function post(message: PtcGuestOutboundMessage): void {
  parentPort?.postMessage(message);
}
