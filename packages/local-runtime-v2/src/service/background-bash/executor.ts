import { StringDecoder } from 'node:string_decoder';

import { createBashTool, type BashOperations } from '@earendil-works/pi-coding-agent/tools';
import { createBashEnvSpawnHook, type BashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';
import {
  localBashResultFromError,
  localBashResultFromPi,
  DESKTOP_BASH_PREVIEW_BYTES,
  type LocalSandboxBashOperationsFactory,
} from '@mavis/agent-tools/desktop';

import type { LocalBackgroundBashExecutor } from './contracts.js';

export function createLocalBackgroundBashExecutor(
  operationsFactory: LocalSandboxBashOperationsFactory,
  /**
   * Supplied by the runtime so background bash inherits the same PATH shims as
   * the foreground tool. REQUIRED: every caller names its policy explicitly —
   * tests pass `{ mode: 'off' }`.
   */
  envPolicy: BashEnvPolicy,
): LocalBackgroundBashExecutor {
  return {
    async execute(input) {
      // Same env sanitizer as the foreground LocalBashTool and the
      // pi-turn-runner fallback — the background path must not become a side
      // door around the boundary strip (bash-tool-optimization.md §2.2).
      // Embedded local hosts opt into a shared IPC guardian because SIGKILL
      // cannot run JS cleanup; cloud keeps its sandbox-owned lifecycle.
      // The operations path owns the callback: `running` may only be persisted
      // once Sandbox admission and wrapping succeeded, never before them.
      const localOperations = operationsFactory.create({
        identity: input.identity,
        workspaceRoot: input.workspaceRoot,
        ...(input.onPreflightComplete ? { onPreflightComplete: input.onPreflightComplete } : {}),
      });
      const decoders = {
        stdout: new StringDecoder('utf8'),
        stderr: new StringDecoder('utf8'),
        combined: new StringDecoder('utf8'),
      };
      const operations: BashOperations = {
        separatesOutputStreams: localOperations.separatesOutputStreams,
        exec: (command, cwd, options) =>
          localOperations.exec(command, cwd, {
            ...options,
            onProcessEvent: (event) => {
              options.onProcessEvent?.(event);
              if (
                event.type === 'timer_started' &&
                event.atMs !== undefined &&
                input.timeout !== undefined
              ) {
                input.onDetails?.({
                  timing: {
                    commandTimerStartedAt: event.atMs,
                    commandDeadlineAt: event.atMs + input.timeout * 1000,
                  },
                });
              }
            },
            onData: (data, stream) => {
              options.onData(data, stream);
              input.onOutput?.(decoders[stream ?? 'combined'].write(data), data.length);
            },
          }),
      };
      let envSanitized: string[] = [];
      const tool = createBashTool(input.workspaceRoot, {
        output: {
          strategy: 'head_tail',
          maxBytes: DESKTOP_BASH_PREVIEW_BYTES,
          maxLines: Number.MAX_SAFE_INTEGER,
          persistOutput: false,
        },
        operations,
        spawnHook: createBashEnvSpawnHook(envPolicy, (removed) => {
          envSanitized = removed;
          if (removed.length > 0) input.onDetails?.({ envSanitized: removed });
        }),
      });
      try {
        const result = localBashResultFromPi(
          await tool.execute('', { command: input.command, timeout: input.timeout }, input.signal),
        );
        return {
          ...result,
          details: { ...result.details, ...(envSanitized.length > 0 ? { envSanitized } : {}) },
        };
      } catch (error) {
        const result = localBashResultFromError(error, input.signal);
        return {
          ...result,
          details: { ...result.details, ...(envSanitized.length > 0 ? { envSanitized } : {}) },
        };
      } finally {
        input.onOutput?.(decoders.stdout.end(), 0);
        input.onOutput?.(decoders.stderr.end(), 0);
        input.onOutput?.(decoders.combined.end(), 0);
      }
    },
  };
}
