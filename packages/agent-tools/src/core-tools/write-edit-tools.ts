/**
 * Host-neutral `write` / `edit` tools: the desktop LocalWriteTool /
 * LocalEditTool with their file IO behind the CoreToolHost port. The desktop
 * subclasses pass physical-fs, so the behavior there is unchanged.
 */

import {
  attachProgrammaticErrorData,
  type ToolExecutionContext,
  type ToolImpl,
  type ToolResult,
  type ToolResultContent,
} from '@mavis/agent-core/tools';
import { createEditTool, createWriteTool } from '@earendil-works/pi-coding-agent/tools';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';

import {
  buildReplaceAllEdit,
  ReplaceAllError,
  withReplaceAllCount,
} from '../shared/replace-all-edit.js';
import {
  executeEditWithLineNumberRetry,
  normalizeEditsForLineNumberRetry,
} from '../shared/edit-line-number-retry.js';
import { createCapturingEditOperations } from '../shared/edit-capture.js';
import { withCompatibleEditToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { buildWriteToolResult, createCapturingWriteOperations } from '../shared/write-capture.js';
import { withDesktopCompletenessReport } from '../desktop/ptc-result-projection.js';
import {
  LocalEditToolDef,
  type LocalEditToolInput,
  LocalWriteToolDef,
  type LocalWriteToolInput,
} from './defs.js';
import { resolveCandidatePath } from './paths.js';
import type { CoreToolHost } from './ports.js';

export class CoreWriteTool<Ctx extends ToolExecutionContext = ToolExecutionContext>
  implements ToolImpl<typeof LocalWriteToolDef.schema, Ctx>
{
  constructor(
    private readonly workspaceRoot: string,
    private readonly host: CoreToolHost,
  ) {}

  async execute(
    _ctx: Ctx,
    input: LocalWriteToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    // Per-execute capture context. This tool instance is a process-level
    // singleton (buildLocalToolRegistry), so an instance-level pending map
    // would be shared across concurrent writes; binding capture to a single
    // execute keeps each write's byte count / diff its own. The injected
    // writeFile still runs inside pi's withFileMutationQueue slot: it captures
    // the old file (BOM/encoding/content) and writes with the preserved
    // encoding — see write-capture.ts / design doc.
    const { operations, takeCapture } = createCapturingWriteOperations(this.host.fs);
    const tool = createWriteTool(this.workspaceRoot, { operations });
    const res = await executeWithFailurePath(input.path, () => tool.execute('', input, signal));
    const capture = takeCapture(resolveCandidatePath(input.path, this.workspaceRoot, this.host));
    const result = buildWriteToolResult(
      LocalWriteToolDef.name,
      input.path,
      input.content,
      capture,
      toToolResult(LocalWriteToolDef.name, res).text,
    );
    const created = result.details?.created;
    const bytesWritten = result.details?.bytes_written;
    return withDesktopCompletenessReport(LocalWriteToolDef.name, result, {
      data: {
        path: input.path,
        ...(typeof created === 'boolean' ? { created } : {}),
        ...(typeof bytesWritten === 'number' ? { bytesWritten } : {}),
      },
    });
  }
}

export class CoreEditTool<Ctx extends ToolExecutionContext = ToolExecutionContext>
  implements ToolImpl<typeof LocalEditToolDef.schema, Ctx>
{
  constructor(
    private readonly workspaceRoot: string,
    private readonly host: CoreToolHost,
  ) {}

  async execute(
    _ctx: Ctx,
    input: LocalEditToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');

    // Translate the compatible style public schema (file_path + old_string +
    // new_string + optional replace_all) into pi's internal
    // { path, edits: [{ oldText, newText }] } shape so we still get
    // pi's BOM strip / line-ending restore / unified-diff /
    // withFileMutationQueue locking for free. The execution is then routed
    // through the line-number-retry wrapper so a model that pasted read's
    // `N→` prefixes into old_string still recovers (CR !4027 P1).
    const capture = createCapturingEditOperations(this.host.fs);
    const { piInput, piResult } = await executeWithFailurePath(input.file_path, async () => {
      const prepared = await buildPiEditInput(input, this.workspaceRoot, this.host);
      const tool = createEditTool(this.workspaceRoot, { operations: capture.operations });
      return {
        piInput: prepared,
        piResult: await executeEditWithLineNumberRetry(tool, prepared, signal),
      };
    });
    const res =
      piInput.replacedCount === undefined
        ? piResult
        : withReplaceAllCount(piResult, piInput.path, piInput.replacedCount);
    const result = toToolResult(LocalEditToolDef.name, res);
    const editCapture = capture.takeCapture(
      resolveCandidatePath(input.file_path, this.workspaceRoot, this.host),
    );
    // replace_all counts every occurrence it replaced; a single edit replaces one.
    const data = {
      path: input.file_path,
      replacements: piInput.replacedCount ?? 1,
      replaceAll: input.replace_all === true,
    };
    if (!editCapture) return withDesktopCompletenessReport(LocalEditToolDef.name, result, { data });
    const normalized =
      result.details?.line_number_prefixes_stripped === true
        ? normalizeEditsForLineNumberRetry([
            { oldText: input.old_string, newText: input.new_string },
          ])?.[0]
        : undefined;
    return withDesktopCompletenessReport(
      LocalEditToolDef.name,
      withCompatibleEditToolResponse(result, {
        filePath: editCapture.path,
        oldString: normalized?.oldText ?? input.old_string,
        newString: normalized?.newText ?? input.new_string,
        originalFile: editCapture.originalFile,
        replaceAll: input.replace_all === true,
        userModified: false,
      }),
      { data },
    );
  }
}

/** Runs a write or edit and, when it throws, leaves the path in PTC data. */
async function executeWithFailurePath<T>(path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    attachProgrammaticErrorData(error, { path });
    throw error;
  }
}

/**
 * Translate LocalEditTool's compatible style input into the `{ path, edits }`
 * shape pi's `createEditTool` expects. `replace_all: true` collapses
 * every occurrence of `old_string` into a single full-file replacement
 * driven through pi's own edit pipeline (see `replace-all-edit.ts` for
 * why we don't model each occurrence as its own edit).
 */
async function buildPiEditInput(
  input: LocalEditToolInput,
  workspaceRoot: string,
  host: CoreToolHost,
): Promise<{
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
  replacedCount?: number;
}> {
  if (input.replace_all === true) {
    // replace_all reads the file itself (outside pi), so it MUST resolve the
    // path exactly like pi's createEditTool does: workspace-relative paths
    // resolve against workspaceRoot, never the runtime process cwd (which is
    // wherever Electron/CLI launched, not the session workspace). Without this,
    // a relative file_path that single-edit handles fine ENOENTs here. Mirrors
    // cloud-edit's resolveWithinWorkspace-before-buildReplaceAllEdit order.
    const absolutePath = resolveCandidatePath(input.file_path, workspaceRoot, host);
    try {
      const replacement = await buildReplaceAllEdit(
        absolutePath,
        input.old_string,
        input.new_string,
        host.fs,
      );
      return {
        path: replacement.path,
        edits: replacement.edits,
        replacedCount: replacement.replacedCount,
      };
    } catch (err) {
      if (err instanceof ReplaceAllError) {
        throw new Error(err.message);
      }
      throw err;
    }
  }
  return {
    path: input.file_path,
    edits: [{ oldText: input.old_string, newText: input.new_string }],
  };
}

function toToolResult(toolName: string, res: AgentToolResult<Record<string, unknown>>): ToolResult {
  const content = res.content as ToolResultContent[];
  return {
    tool_name: toolName,
    text: content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    content,
    details: (res.details ?? {}) as Record<string, unknown>,
    ...(res.terminate !== undefined ? { terminate: res.terminate } : {}),
  };
}
