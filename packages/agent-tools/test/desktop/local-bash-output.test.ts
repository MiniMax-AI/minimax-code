/**
 * Real foreground commands verify bounded head/tail previews and complete
 * persisted output across the Pi executor and Desktop tool boundary.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalBashTool } from '../../src/desktop/local-pi-tools.js';
import { DESKTOP_BASH_MAX_BYTES } from '../../src/desktop/output-limit.js';
import { readPluginHookCompatibleToolResponse } from '../../src/plugin-hooks/vendor-tool-response.js';
import type { LocalRuntimeToolContext } from '../../src/desktop/types.js';

const SESSION_CTX = {
  sessionId: 'sess-test',
  turnId: 'turn-test',
} satisfies LocalRuntimeToolContext;

describe('LocalBashTool — foreground output truncation', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'bash-output-'));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('preserves exact stdout and stderr for Compatible PostToolUse', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const result = await tool.execute(SESSION_CTX, {
      command: "printf 'from-stdout'; printf 'from-stderr' >&2",
    });

    expect(readPluginHookCompatibleToolResponse(result)).toEqual({
      stdout: 'from-stdout',
      stderr: 'from-stderr',
      interrupted: false,
    });
  });

  it('short output is returned verbatim, not truncated', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const result = await tool.execute(SESSION_CTX, { command: 'printf "a\\nb\\nc\\n"' });
    expect(result.tool_name).toBe('bash');
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('a');
    expect(result.text.toLowerCase()).not.toContain('full output:');
  });

  it('caps 24-50 KiB foreground output with head and tail and persists the complete output', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const script = `for(let i=0;i<400;i++) console.log('row-'+i+'-'+'x'.repeat(90))`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = await tool.execute(SESSION_CTX, { command });

    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      DESKTOP_BASH_MAX_BYTES,
    );
    expect(result.text).toContain('row-0-');
    expect(result.text).toContain('row-399-');
    expect(result.text).not.toContain('row-200-');
    expect(result.text.toLowerCase()).toContain('full output:');
    const fullOutput = await readFile(result.details?.fullOutputPath as string, 'utf8');
    expect(fullOutput.split('\n').filter(Boolean)).toHaveLength(400);
    expect(fullOutput).toContain('row-200-');
    expect(result.details?.desktop_output_truncation).toMatchObject({
      truncated: true,
      has_more: true,
      strategy: 'head_tail_lines',
      max_bytes: DESKTOP_BASH_MAX_BYTES,
      continuation_hint: {
        tool: 'read',
        preserve_args: ['path'],
      },
    });
    expect(result.details?.desktop_output_truncation).not.toHaveProperty('next_offset');
    expect(result.details?.desktop_output_truncation).not.toHaveProperty('offset_unit');
  });

  it('caps a thrown timeout result while preserving the error ToolResult status', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const innerExecute = vi
      .spyOn((tool as unknown as { tool: { execute: unknown } }).tool, 'execute')
      .mockRejectedValue(
        new Error(
          `${'timeout-output\n'.repeat(2_000)}\n\nCommand timed out after 1 seconds`,
        ),
      );

    const result = await tool.execute(SESSION_CTX, { command: 'ignored', timeout: 1 });

    expect(innerExecute).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      DESKTOP_BASH_MAX_BYTES,
    );
    expect(result.text).toContain('Command timed out after 1 seconds');
    expect(result.text).toContain('desktop bash output truncated');
    expect(result.details?.desktop_output_truncation).toMatchObject({
      truncated: true,
      has_more: true,
      strategy: 'head_tail_lines',
      max_bytes: DESKTOP_BASH_MAX_BYTES,
      continuation_hint: {
        tool: 'bash',
        preserve_args: [],
      },
    });
  });

  it('still propagates an active AbortSignal instead of converting cancellation to a tool result', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const controller = new AbortController();
    vi.spyOn((tool as unknown as { tool: { execute: unknown } }).tool, 'execute').mockImplementation(
      async () => {
        controller.abort();
        throw new Error('Command aborted');
      },
    );

    await expect(
      tool.execute(SESSION_CTX, { command: 'ignored' }, controller.signal),
    ).rejects.toThrow('Command aborted');
  });

  it('caps a large nonzero-exit result while preserving the error ToolResult status', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const script = `for(let i=0;i<400;i++) console.error('error-row-'+i+'-'+'e'.repeat(90)); process.exit(7)`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = await tool.execute(SESSION_CTX, { command });

    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      DESKTOP_BASH_MAX_BYTES,
    );
    expect(result.text).toContain('error-row-0-');
    expect(result.text).toContain('error-row-399-');
    expect(result.text).not.toContain('error-row-200-');
    expect(result.text).toContain('Command exited with code 7');
    expect(result.text).toContain('desktop bash output truncated');
    expect(result.details?.desktop_output_truncation).toMatchObject({
      truncated: true,
      has_more: true,
      strategy: 'head_tail_lines',
      max_bytes: DESKTOP_BASH_MAX_BYTES,
      continuation_hint: {
        tool: 'read',
        preserve_args: ['path'],
      },
    });
  });

  it('output beyond 2000 lines preserves head and tail with a complete output file', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const script = `for(let i=0;i<3000;i++) console.log('spill-row-'+i+'-'+'z'.repeat(50))`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = await tool.execute(SESSION_CTX, { command });

    const lower = result.text.toLowerCase();
    expect(lower).toContain('full output:');
    expect(lower).toContain('original head+tail shown');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      DESKTOP_BASH_MAX_BYTES,
    );

    expect(result.text).toContain('spill-row-2999-');
    expect(result.text).toContain('spill-row-0-');
    expect(result.text).not.toContain('spill-row-1500-');
    expect(result.details?.desktop_output_truncation).toMatchObject({
      truncated: true,
      has_more: true,
      strategy: 'head_tail_lines',
      max_bytes: DESKTOP_BASH_MAX_BYTES,
      continuation_hint: {
        tool: 'read',
        preserve_args: ['path'],
      },
    });

    // Recover the spilled path from the footer and confirm it holds the FULL output.
    const m = result.text.match(/full output:\s*(.+?)\]/i);
    expect(m).not.toBeNull();
    const full = await readFile((m as RegExpMatchArray)[1].trim(), 'utf-8');
    const fullLines = full.split('\n').filter((l) => l.length > 0);
    expect(fullLines).toHaveLength(3000);
    expect(fullLines[0]).toContain('spill-row-0-');
    expect(fullLines[fullLines.length - 1]).toContain('spill-row-2999-');
  });
});
