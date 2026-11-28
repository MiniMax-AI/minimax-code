/**
 * matrix_web_search — Pattern A: No file I/O; forward input/output directly to matrix-tools.
 *
 * Constructor parameters `_ossMediaClient` / `_workspaceScope` only keep `buildMatrixTools(...)`
 * construction uniform across all 18 tools; search tools do not use these dependencies.
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
