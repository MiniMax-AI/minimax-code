/**
 * LocalGrepTool —— `grep` 工具的 desktop 实现（对应 cloud/cloud-grep.ts）：
 * host 中立的 CoreGrepTool（`../core-tools/grep-tool.ts`）绑定物理 fs 与内置
 * ripgrep 的薄包装。argv 组装等纯函数从原路径继续导出。
 */

import { bindTool } from '@mavis/agent-core/tools';

import { CoreGrepTool } from '../core-tools/grep-tool.js';
import { LocalGrepToolDef } from './builtin-defs.js';
import { localCoreToolHost } from './local-core-tool-host.js';
import type { RunRgOptions } from './local-rg-runner.js';
import type { LocalRuntimeToolContext } from './types.js';

export {
  buildGrepArgs,
  type GrepArgsInput,
  MAX_FILESIZE_FLAG,
  sortFilesByMtime,
} from '../core-tools/grep-tool.js';

@bindTool(LocalGrepToolDef)
export class LocalGrepTool extends CoreGrepTool<LocalRuntimeToolContext> {
  constructor(
    workspaceRoot: string,
    /** Runner overrides (byte cap / timeouts) — used by tests; production uses defaults. */
    rgOptions: Pick<RunRgOptions, 'maxStdoutBytes' | 'timeoutMs' | 'killGraceMs'> = {},
  ) {
    super(workspaceRoot, localCoreToolHost, { rgOptions });
  }
}
