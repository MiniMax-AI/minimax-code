/**
 * One command through Pi's bash tool with the desktop output settings
 * (head+tail preview within the desktop byte limits). CoreBashTool runs its
 * direct foreground commands this way; a host that runs a command elsewhere
 * can replay the finished run through `createOperations` to get the same
 * result text.
 */

import {
  createBashTool,
  type BashOperations,
  type BashSpawnHook,
} from '@earendil-works/pi-coding-agent/tools';

import { localBashResultFromError, localBashResultFromPi } from '../desktop/local-bash-result.js';
import {
  DESKTOP_BASH_MAX_OUTPUT_BYTES,
  DESKTOP_BASH_MAX_PENDING_OUTPUT_BYTES,
  DESKTOP_BASH_PREVIEW_BYTES,
} from '../desktop/output-limit.js';
import type { LocalBackgroundBashExecutorResult } from '../desktop/types.js';

export interface PiBashOptions {
  /** Operations of this run, created inside the run so a failure becomes its result; absent uses Pi's local shell. */
  readonly createOperations?: () => BashOperations;
  readonly spawnHook?: BashSpawnHook;
  /** `false` keeps the output in memory. */
  readonly persistOutput?: false;
}

export type PiBashResult = LocalBackgroundBashExecutorResult;

/** An abort is rethrown; every other failure becomes an error result. */
export async function runPiBash(
  workspaceRoot: string,
  input: { readonly command: string; readonly timeout?: number },
  options: PiBashOptions = {},
  signal?: AbortSignal,
): Promise<PiBashResult> {
  try {
    const tool = createBashTool(workspaceRoot, {
      output: {
        strategy: 'head_tail',
        maxBytes: DESKTOP_BASH_PREVIEW_BYTES,
        maxTotalBytes: DESKTOP_BASH_MAX_OUTPUT_BYTES,
        maxPendingBytes: DESKTOP_BASH_MAX_PENDING_OUTPUT_BYTES,
        maxLines: Number.MAX_SAFE_INTEGER,
        ...(options.persistOutput === false ? { persistOutput: false } : {}),
      },
      ...(options.createOperations ? { operations: options.createOperations() } : {}),
      ...(options.spawnHook ? { spawnHook: options.spawnHook } : {}),
    });
    return localBashResultFromPi(await tool.execute('', input, signal));
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    return localBashResultFromError(error, signal);
  }
}
