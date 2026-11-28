/**
 * matrix_get_voice_list —— Pattern A:无入参、无文件 I/O,纯透传给 matrix-tools
 * 拿 voice_id + voice_name 列表。`_ossMediaClient` / `_workspaceScope` 留着只
 * 为统一 `buildMatrixTools` 实例化口径,本工具不会用到。
 */

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import { callMatrixTool, type MatrixExecutor } from '../client.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixGetVoiceListToolDef,
  type MatrixGetVoiceListInput,
} from '../tool-defs.js';

@bindTool(MatrixGetVoiceListToolDef)
export class MatrixGetVoiceListTool implements ToolImpl<
  typeof MatrixGetVoiceListToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly _ossMediaClient: MatrixMediaClient,
    private readonly _workspaceScope: MatrixPathScope,
  ) {}

  execute(
    ctx: MatrixToolContext,
    input: MatrixGetVoiceListInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return callMatrixTool({
      toolName: MatrixGetVoiceListToolDef.name,
      path: MATRIX_TOOL_PATHS[MatrixGetVoiceListToolDef.name],
      input,
      ctx,
      archonServer: this.archonServer,
      ...(signal ? { signal } : {}),
    });
  }
}
