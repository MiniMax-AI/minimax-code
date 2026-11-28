/**
 * matrix_videos_understand —— Pattern B(batch-only):一次调用最多 5 个本地
 * 视频走 mcp-server 后端 Gemini 理解,返回 list<MediaUnderstandResult> 文本。
 * 调用方有多个视频时必须 batch 一次性传完,不要 loop 调用本工具。不下载任何
 * 产物文件。
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
