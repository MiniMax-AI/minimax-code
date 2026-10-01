import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';
import { MEMORY_TOOL_OUTPUT_MAX_BYTES } from '@mavis/shared/memory-limits';

import { LocalMemoryToolDef, type LocalMemoryToolInput } from './builtin-defs.js';
import {
  applyDesktopTextLimit,
  limitDesktopHeadTailLines,
} from './output-limit.js';
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
    };
    return applyDesktopTextLimit(
      toolResult,
      limitDesktopHeadTailLines(result.text, {
        maxBytes: MEMORY_TOOL_OUTPUT_MAX_BYTES,
        notice: () =>
          '[Memory output truncated. Narrow the memory search query or use the read tool with a file path and offset/limit to inspect more.]',
      }),
    );
  }
}
