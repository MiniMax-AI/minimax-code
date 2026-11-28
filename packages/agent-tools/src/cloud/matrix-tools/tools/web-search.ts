/**
 * matrix_web_search —— Pattern A:无文件 I/O,input/output 直接透传 matrix-tools。
 *
 * 留 `_ossMediaClient` / `_workspaceScope` 在构造函数里只是为了让所有 18 个
 * matrix-tools tool 共享同一个 `buildMatrixTools(...)` 实例化口径,搜索类
 * 工具本身不会用到这两个依赖。
 */

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import { callMatrixTool, type MatrixExecutor } from '../client.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixWebSearchToolDef,
  type MatrixWebSearchInput,
} from '../tool-defs.js';

@bindTool(MatrixWebSearchToolDef)
export class MatrixWebSearchTool implements ToolImpl<
  typeof MatrixWebSearchToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly _ossMediaClient: MatrixMediaClient,
    private readonly _workspaceScope: MatrixPathScope,
  ) {}

  execute(
    ctx: MatrixToolContext,
    input: MatrixWebSearchInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return callMatrixTool({
      toolName: MatrixWebSearchToolDef.name,
      path: MATRIX_TOOL_PATHS[MatrixWebSearchToolDef.name],
      input,
      ctx,
      archonServer: this.archonServer,
      ...(signal ? { signal } : {}),
    });
  }
}
