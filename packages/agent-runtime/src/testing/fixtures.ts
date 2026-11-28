/**
 * Runtime test fixtures — imported by `@mavis/agent-extension` adapter tests via the
 * `@mavis/agent-runtime/testing` subpath. Pure — no `node:fs` / build tooling
 * imports, so consumers that only need a `TurnAssemblyCtx` fixture don't
 * transitively pull the vitest-alias helper.
 */

import os from 'node:os';
import path from 'node:path';
import type { TurnAssemblyCtx } from '../types.js';

const DEFAULT_WORKSPACE_MARKER = path.join(os.tmpdir(), 'agent-runtime-test-workspace');

/**
 * Build a minimal `TurnAssemblyCtx` for extension SPI tests. Override any
 * field via `overrides`; the rest fall back to test-stable defaults.
 */
export function baseCtx(overrides: Partial<TurnAssemblyCtx> = {}): TurnAssemblyCtx {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    agentName: 'test-agent',
    workspaceDir: DEFAULT_WORKSPACE_MARKER,
    agentConfig: {},
    model: {},
    history: [],
    userInput: { text: 'hi' },
    sendsUserMessage: true,
    ...overrides,
  };
}
