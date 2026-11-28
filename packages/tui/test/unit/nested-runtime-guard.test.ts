import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NESTED_RUNTIME_DELETE_GUARD_ENV,
  NestedRuntimeUnsupportedError,
  nestedRuntimeGuardEnv,
} from '@mavis/shared/nested-runtime-guard';

import { createTuiRuntime } from '../../src/runtime/lifecycle.js';
import { noopTuiObservability } from '../../src/observability/index.js';

const ORIGINAL_MARKER = process.env[NESTED_RUNTIME_DELETE_GUARD_ENV];

let dataDir: string;

/** Stubs only the seams that would otherwise touch the terminal or the disk. */
function runtimeDependencies(factory: ReturnType<typeof vi.fn>) {
  return {
    factory: factory as never,
    createObservability: () => noopTuiObservability,
    createLogging: () => ({
      logDirectory: join(tmpdir(), 'mcode-nested-guard-logs'),
      runDuringStartup: async <T>(operation: () => Promise<T>) => operation(),
      shutdown: async () => undefined,
    }),
  };
}

beforeEach(async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  dataDir = await mkdtemp(join(tmpdir(), 'mcode-nested-guard-'));
});

afterEach(async () => {
  if (ORIGINAL_MARKER === undefined) delete process.env[NESTED_RUNTIME_DELETE_GUARD_ENV];
  else process.env[NESTED_RUNTIME_DELETE_GUARD_ENV] = ORIGINAL_MARKER;
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
  await rm(`${dataDir}.lock`, { recursive: true, force: true });
});

describe('nested MCode Runtime guard', () => {
  it('refuses the embedded Runtime and leaves no storage lock behind', async () => {
    Object.assign(process.env, nestedRuntimeGuardEnv());
    const factory = vi.fn();

    await expect(
      createTuiRuntime(
        { dataDir, workspaceDir: '/workspace', version: '0.1.0' },
        runtimeDependencies(factory),
      ),
    ).rejects.toBeInstanceOf(NestedRuntimeUnsupportedError);

    // Nothing that can take ownership of the shared data directory may run:
    // under delete_guard the nested process could create these artifacts but
    // never remove them again.
    expect(factory).not.toHaveBeenCalled();
    expect(existsSync(`${dataDir}.lock`)).toBe(false);
  });

  it('keeps the embedded Runtime for an unmanaged direct terminal start', async () => {
    delete process.env[NESTED_RUNTIME_DELETE_GUARD_ENV];
    const startupFailure = new Error('embedded host reached');
    const factory = vi.fn(async () => {
      throw startupFailure;
    });

    await expect(
      createTuiRuntime(
        { dataDir, workspaceDir: '/workspace', version: '0.1.0' },
        runtimeDependencies(factory),
      ),
    ).rejects.toBe(startupFailure);
    expect(factory).toHaveBeenCalledOnce();
  });
});
