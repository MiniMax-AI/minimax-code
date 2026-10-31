import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';
import { MEMORY_TOOL_OUTPUT_MAX_BYTES } from '@mavis/shared/memory-limits';

import { LocalMemoryToolDef, type LocalMemoryToolInput } from './builtin-defs.js';
import {
  applyDesktopTextLimit,
  isPtcChildCall,
  limitDesktopHeadTailLines,
} from './output-limit.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
import type { LocalMemoryAdapter, LocalRuntimeToolContext } from './types.js';

@bindTool(LocalMemoryToolDef)
export class LocalMemoryTool implements ToolImpl<
  typeof LocalMemoryToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalMemoryAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalMemoryToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const result = await this.adapter.execute(ctx, input, signal);
    const toolResult: ToolResult = {
      tool_name: LocalMemoryToolDef.name,
      text: result.text,
      content: [{ type: 'text', text: result.text }],
      details: { kind: 'memory', ...(result.details ?? {}) },
      // A failed operation is an error result, not text that reads like memory.
      ...(result.details?.ok === false ? { isError: true } : {}),
    };
    if (isPtcChildCall(ctx)) {
      // A run_code child gets the whole text and data (see isPtcChildCall).
      const uncappedOutput = Buffer.byteLength(result.text, 'utf8') > MEMORY_TOOL_OUTPUT_MAX_BYTES;
      return withDesktopCompletenessReport(LocalMemoryToolDef.name, toolResult, {
        ...(result.data ? { data: result.data } : {}),
        ...(uncappedOutput ? { uncappedOutput } : {}),
      });
    }
    const limited = applyDesktopTextLimit(
      toolResult,
      limitDesktopHeadTailLines(result.text, {
        maxBytes: MEMORY_TOOL_OUTPUT_MAX_BYTES,
        notice: () =>
          '[Memory output truncated. Narrow the memory search query or use the read tool with a file path and offset/limit to inspect more.]',
      }),
    );
    const cut = limited.details?.desktop_output_truncation !== undefined;
    const data = result.data && (cut ? memoryMetadata(result.data) : result.data);
    return withDesktopCompletenessReport(LocalMemoryToolDef.name, limited, data ? { data } : {});
  }
}

/**
 * The head+tail cut drops the middle of the text, so no content field could
 * end where the text does; only counts and sizes survive it.
 */
function memoryMetadata(data: Record<string, unknown>): Record<string, unknown> {
  const { ok, target, operation, sizeBytes, matches, topics } = data;
  return {
    ok,
    target,
    operation,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(Array.isArray(matches) ? { matchCount: matches.length } : {}),
    ...(Array.isArray(topics) ? { topicCount: topics.length } : {}),
  };
}
