import { describe, expect, it, vi } from 'vitest';

import { LocalMemoryTool } from '../../src/desktop/local-memory.js';
import { MEMORY_TOOL_OUTPUT_MAX_BYTES } from '@mavis/shared/memory-limits';
import type { LocalRuntimeToolContext } from '../../src/desktop/types.js';

const context: LocalRuntimeToolContext = {
  sessionId: 'memory-session',
  turnId: 'turn',
  toolCallId: 'call',
  agentName: 'mavis',
};

describe('LocalMemoryTool output limit', () => {
  it.each(['user', 'main', 'topic'] as const)(
    'bounds oversized %s reads in both model-facing fields',
    async (target) => {
      const text = 'FIRST_FACT\n' + '记忆🙂'.repeat(20_000) + '\nLATEST_FACT';
      const execute = vi.fn(async () => ({ text, details: { ok: true, target } }));
      const tool = new LocalMemoryTool({ execute });
      const input = { target, operation: 'read' as const, topicName: 'work' };
      const result = await tool.execute(context, input);

      expect(execute).toHaveBeenCalledWith(context, input, undefined);
      expect(Buffer.byteLength(result.text!)).toBeLessThanOrEqual(MEMORY_TOOL_OUTPUT_MAX_BYTES);
      expect(result.text).toContain('FIRST_FACT');
      expect(result.text).toContain('LATEST_FACT');
      expect(result.text).toContain('Memory output truncated');
      expect(Buffer.from(result.text!).toString('utf8')).toBe(result.text);
      expect(result.content).toEqual([{ type: 'text', text: result.text }]);
      expect(result.details).toMatchObject({
        kind: 'memory',
        ok: true,
        target,
        desktop_output_truncation: { truncated: true, original_bytes: Buffer.byteLength(text) },
      });
    },
  );

  it('bounds search results as well as direct reads', async () => {
    const tool = new LocalMemoryTool({
      execute: async () => ({ text: JSON.stringify([{ line: '记'.repeat(80_000) }]) }),
    });
    const result = await tool.execute(context, {
      target: 'main',
      operation: 'search',
      query: '记',
    });
    expect(Buffer.byteLength(result.text!)).toBeLessThanOrEqual(MEMORY_TOOL_OUTPUT_MAX_BYTES);
    expect(result.details?.desktop_output_truncation).toMatchObject({ truncated: true });
  });

  it.each(['short memory', 'a'.repeat(MEMORY_TOOL_OUTPUT_MAX_BYTES)])(
    'preserves an output within the budget',
    async (text) => {
      const tool = new LocalMemoryTool({ execute: async () => ({ text, details: { ok: true } }) });
      const result = await tool.execute(context, { target: 'main', operation: 'read' });
      expect(result.text).toBe(text);
      expect(result.content).toEqual([{ type: 'text', text }]);
      expect(result.details).toEqual({ kind: 'memory', ok: true });
    },
  );
});
