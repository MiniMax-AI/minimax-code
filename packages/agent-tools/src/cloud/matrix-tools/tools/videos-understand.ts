/**
 * matrix_videos_understand — Pattern B (batch-only): Send up to five local videos per call to
 * mcp-server's Gemini backend and return list<MediaUnderstandResult> text. Callers with multiple
 * videos must send them in one batch rather than loop over calls. No artifact files are downloaded.
 */

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import { callMatrixTool, type MatrixExecutor } from '../client.js';
import {
  FileTransferError,
  fileTransferFailureResult,
  uploadInputFiles,
  uploadedInputFileToMediaInfo,
} from '../file-transfer.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixVideosUnderstandToolDef,
  type MatrixVideosUnderstandInput,
} from '../tool-defs.js';

@bindTool(MatrixVideosUnderstandToolDef)
export class MatrixVideosUnderstandTool implements ToolImpl<
  typeof MatrixVideosUnderstandToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly ossMediaClient: MatrixMediaClient,
    private readonly workspaceScope: MatrixPathScope,
  ) {}

  async execute(
    ctx: MatrixToolContext,
    input: MatrixVideosUnderstandInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const toolName = MatrixVideosUnderstandToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];
    try {
      const uploaded = await uploadInputFiles(
        input.video_info.map((it) => it.file_path),
        this.workspaceScope,
        this.ossMediaClient,
      );
      const body = {
        video_info: input.video_info.map((it, i) =>
          uploadedInputFileToMediaInfo(uploaded[i]!, it.prompt),
        ),
      };
      return await callMatrixTool({
        toolName,
        path,
        input: body,
        ctx,
        archonServer: this.archonServer,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (err instanceof FileTransferError) {
        return fileTransferFailureResult(toolName, path, err);
      }
      throw err;
    }
  }
}
