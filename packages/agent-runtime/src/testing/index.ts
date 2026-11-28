/**
 * `@mavis/agent-runtime/testing` public entry — re-exports the two testing
 * concerns (runtime fixtures + vitest resolve.alias helper) from separate
 * module files so consumers only pull what they need. Downstream imports:
 *
 *   // Only baseCtx() — no `node:fs` pull.
 *   import { baseCtx } from '@mavis/agent-runtime/testing';
 *
 *   // vitest resolve.alias helper — needs node:fs for workspace-root walk.
 *   import { agentRuntimeVitestAliases } from '@mavis/agent-runtime/testing';
 */

export { baseCtx } from './fixtures.js';
export { agentRuntimeVitestAliases } from './vitest.js';
