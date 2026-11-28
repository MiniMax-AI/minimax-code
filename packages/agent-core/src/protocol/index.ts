/**
 * Protocol types shared by `agent-core` consumers.
 *
 * Three families:
 * - `agent-message.ts` — `AgentMessage` / `AgentMessageChunk` (legacy SSE
 *   wire format, kept for Phase 1 compatibility with daemon's UI clients).
 * - `agent-event.ts` — `AgentEvent` (in-process event stream emitted by an
 *   `Agent` runtime as it advances through an LLM turn).
 * - `runtime-event.ts` — `RuntimeEvent` (canonical wire format, re-exported
 *   from `@mavis/protocol`).
 */

export * from './agent-message.js';
export * from './stream-reset.js';
export * from './agent-event.js';
export * from './context-usage.js';
export * from './runtime-event.js';
export * from './user-message-origin.js';
