/**
 * `createAgentRuntime` —— agent-runtime 的入口工厂。
 * Host 传 `{ base, additions, overlays, profile }`，返回一个 `AgentRuntime`（含
 * `assembleTurn / setEnabled / listExtensions / disposeSession`）。
 *
 * 实现：`Registry` 持有装配状态并实现 `AgentRuntime`。每个 extension `init`
 * 收到独立的 owner-scoped `ExtensionAPI` facade；该 facade 只能在对应 owner 的
 * init 窗口注册贡献。工厂返回时按 `AgentRuntime` 收窄类型，host 不会拿到
 * `registerTool` 等 SPI 方法。
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
  // 返回类型收窄到 AgentRuntime；owner-scoped ExtensionAPI 只在 init 期间存在。
  return registry;
}
