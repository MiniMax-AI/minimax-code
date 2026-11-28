/**
 * LocalGlobTool —— `glob` 工具的 desktop 实现（对应 cloud/cloud-glob.ts）：
 * host 中立的 CoreGlobTool（`../core-tools/glob-tool.ts`）绑定物理 fs 与内置
 * ripgrep 的薄包装。argv 组装等纯函数从原路径继续导出。
 */

import { bindTool } from '@mavis/agent-core/tools';

import { CoreGlobTool } from '../core-tools/glob-tool.js';
import { LocalGlobToolDef } from './builtin-defs.js';
import { localCoreToolHost } from './local-core-tool-host.js';
import type { RunRgOptions } from './local-rg-runner.js';
import type { LocalRuntimeToolContext } from './types.js';

export { buildGlobArgs, type GlobArgsInput, splitAbsoluteGlob } from '../core-tools/glob-tool.js';

@bindTool(LocalGlobToolDef)
export class LocalGlobTool extends CoreGlobTool<LocalRuntimeToolContext> {
  constructor(
    workspaceRoot: string,
    /** Runner overrides (byte cap / timeouts) — used by tests; production uses defaults. */
    rgOptions: Pick<RunRgOptions, 'maxStdoutBytes' | 'timeoutMs' | 'killGraceMs'> = {},
  ) {
    super(workspaceRoot, localCoreToolHost, { rgOptions });
  }
}
