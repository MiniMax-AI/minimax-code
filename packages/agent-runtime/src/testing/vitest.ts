/**
 * Vitest resolve.alias helper — imported by downstream module `vitest.config.ts`
 * files via the `@mavis/agent-runtime/testing` subpath. Pulls `node:fs` for
 * workspace-root discovery; kept separate from `fixtures.ts` so consumers
 * needing only `baseCtx()` don't transitively depend on `fs`.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Compute the `resolve.alias` block for a downstream vitest.config.ts.
 * Pass the `import.meta.url`-derived directory of the caller's vitest.config;
 * this helper walks up to the workspace root and produces src paths.
 *
 * Adding a new `agent-core` subpath only needs to touch this single helper.
 */
export function agentRuntimeVitestAliases(vitestConfigDir: string): Record<string, string> {
  const workspaceRoot = findWorkspaceRoot(vitestConfigDir);
  const agentRuntimeDir = path.join(workspaceRoot, 'packages/agent-runtime');
  const agentCoreDir = path.join(workspaceRoot, 'packages/agent-core');
  return {
    '@mavis/agent-runtime/testing': path.join(agentRuntimeDir, 'src/testing/index.ts'),
    '@mavis/agent-runtime': path.join(agentRuntimeDir, 'src/index.ts'),
    '@mavis/agent-core/tools': path.join(agentCoreDir, 'src/tools/index.ts'),
    '@mavis/agent-core/pi-turn-runner': path.join(agentCoreDir, 'src/pi-turn-runner/index.ts'),
    '@mavis/agent-core/protocol/agent-message': path.join(
      agentCoreDir,
      'src/protocol/agent-message.ts',
    ),
    '@mavis/agent-core/protocol/runtime-event': path.join(
      agentCoreDir,
      'src/protocol/runtime-event.ts',
    ),
    '@mavis/agent-core/protocol': path.join(agentCoreDir, 'src/protocol/index.ts'),
    '@mavis/agent-core/event-bridge': path.join(agentCoreDir, 'src/event-bridge/index.ts'),
    '@mavis/agent-core/bash-subprocess-env': path.join(agentCoreDir, 'src/bash-subprocess-env.ts'),
    '@mavis/agent-core': path.join(agentCoreDir, 'src/index.ts'),
  };
}

// Walk up until we find the workspace root marker (pnpm-workspace.yaml).
// `parent === dir` terminates when we reach the filesystem root — the natural
// termination condition. No arbitrary hop cap.
function findWorkspaceRoot(startDir: string): string {
  const marker = 'pnpm-workspace.yaml';
  let dir = startDir;
  // Loop terminates at the filesystem root when path.dirname stops changing.
  // No arbitrary hop cap — no artificial limit hiding a bad path.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `agentRuntimeVitestAliases: could not locate pnpm-workspace.yaml above '${startDir}'`,
      );
    }
    dir = parent;
  }
}
