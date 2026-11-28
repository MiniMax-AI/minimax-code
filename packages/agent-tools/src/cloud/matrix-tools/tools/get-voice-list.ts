/**
 * matrix_get_voice_list — Pattern A: No input or file I/O; forward directly to matrix-tools for
 * voice_id + voice_name pairs. `_ossMediaClient` / `_workspaceScope` exist only to keep
 * `buildMatrixTools` construction uniform and are unused here.
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
