import {
  type PtcStopReason,
  type PtcToolBridge,
  type PtcToolCall,
  type PtcToolCallResult,
  type PtcToolDescriptor,
} from './contracts.js';
import { PtcSubcallScheduler } from './subcall-scheduler.js';

export interface CreatePtcToolBridgeOptions {
  readonly tools: readonly PtcToolDescriptor[];
  readonly maxConcurrentToolCalls: number;
  /** Must enter Agent Core's shared Pi single-call flow, never impl.execute. */
  execute(call: PtcToolCall): Promise<PtcToolCallResult>;
  describe?: PtcToolBridge['describe'];
}

export function createPtcToolBridge(options: CreatePtcToolBridgeOptions): PtcToolBridge {
  const byName = new Map<string, PtcToolDescriptor>();
  for (const tool of options.tools) {
    if (!isSafeToolName(tool.name) || byName.has(tool.name)) {
      throw new Error(`Invalid or duplicate PTC tool name: ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }
  const scheduler = new PtcSubcallScheduler(options.maxConcurrentToolCalls);
  return {
    toolNames: [...byName.keys()],
    ...(options.describe ? { describe: options.describe } : {}),
    invoke: async (call) => {
      const tool = byName.get(call.name);
      if (!tool) throw new Error(`Tool is not available to PTC: ${call.name}`);
      return await scheduler.run(
        tool.executionMode,
        (signal) => options.execute({ ...call, signal }),
        call.signal,
      );
    },
    stop: (reason: PtcStopReason) => scheduler.stop(new Error(`PTC stopped: ${reason}`)),
    drain: () => scheduler.drain(),
  };
}

function isSafeToolName(name: string): boolean {
  return Boolean(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
}
