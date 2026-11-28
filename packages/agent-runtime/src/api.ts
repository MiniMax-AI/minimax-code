/**
 * `createAgentRuntime`: Entry factory for agent-runtime. The host passes `{ base, additions,
 * overlays, profile }` and receives an `AgentRuntime` exposing `assembleTurn / setEnabled /
 * listExtensions / disposeSession`.
 *
 * Implementation: `Registry` holds assembly state and implements `AgentRuntime`. Each extension's
 * `init` receives an independent owner-scoped `ExtensionAPI` facade, which can register
 * contributions only during that owner's init window. The factory narrows the return type to
 * `AgentRuntime`, so the host does not receive SPI methods such as `registerTool`.
 */

import { Registry } from './registry.js';
import { resolveExtensions } from './resolve.js';
import type { AgentRuntime, RuntimeOptions } from './types.js';

export async function createAgentRuntime(opts: RuntimeOptions): Promise<AgentRuntime> {
  const extensions = resolveExtensions(
    opts.base,
    opts.additions ?? [],
    opts.overlays ?? {},
    opts.profile,
  );
  const overlay = opts.profile ? opts.overlays?.[opts.profile] : undefined;
  const params: Readonly<Record<string, unknown>> = overlay?.param ?? {};
  const registry = new Registry(params);
  await registry.initExtensions(extensions);
  // Narrow the return type to AgentRuntime; owner-scoped ExtensionAPI exists only during init.
  return registry;
}
