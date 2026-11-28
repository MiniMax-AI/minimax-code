import {
  bindTool,
  type ToolExecutionContext,
  type ToolImpl,
  type ToolResult,
} from '@mavis/agent-core/tools';

import { LocalFeatureEnableToolDef, type LocalFeatureEnableToolInput } from './defs.js';
import type { AskUserAdapter } from './types.js';

@bindTool(LocalFeatureEnableToolDef)
export class LocalFeatureEnableTool<TContext extends ToolExecutionContext> implements ToolImpl<
  typeof LocalFeatureEnableToolDef.schema,
  TContext
> {
  constructor(private readonly adapter: AskUserAdapter<TContext>) {}

  async execute(
    ctx: TContext,
    input: LocalFeatureEnableToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const result = await this.adapter.begin(
      ctx,
      {
        mode: 'feature-enable',
        modePayload: { featureKey: input.featureKey },
      },
      signal,
    );
    if ('suppressed' in result) {
      // The adapter only suppresses plain questionnaires; a consent prompt
      // must never be silently skipped, so treat this as a hard wiring error.
      throw new Error('feature-enable prompt unexpectedly suppressed');
    }
    const text = `Feature enable request ${result.requestId} is waiting for the local user. Stop this turn until the user replies.`;
    return {
      tool_name: LocalFeatureEnableToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        request_id: result.requestId,
        schema_version: result.schemaVersion,
        step_count: result.stepCount,
        waiting_for_user: true,
      },
      terminate: true,
    };
  }
}
