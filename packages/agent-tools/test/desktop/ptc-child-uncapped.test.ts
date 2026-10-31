/**
 * run_code (PTC) child calls skip the model-visible output caps: a context
 * with `parentToolCallId` gets the whole result in text and data, reported
 * complete, while a top-level call keeps every cap (desktop/output-limit.ts
 * isPtcChildCall).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolResult } from '@mavis/agent-core/tools';
import { MEMORY_TOOL_OUTPUT_MAX_BYTES } from '@mavis/shared/memory-limits';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalGrepTool } from '../../src/desktop/local-grep.js';
import { LocalMavisTool } from '../../src/desktop/local-mavis.js';
import { LocalMemoryTool } from '../../src/desktop/local-memory.js';
import { LocalBashTool, LocalReadTool } from '../../src/desktop/local-pi-tools.js';
import { LocalWebFetchTool } from '../../src/desktop/local-webfetch.js';
import {
  DESKTOP_BASH_MAX_BYTES,
  DESKTOP_GREP_CONTENT_MAX_BYTES,
  DESKTOP_READ_TEXT_MAX_BYTES,
  isPtcChildCall,
} from '../../src/desktop/output-limit.js';
import { projectDesktopPtcToolResult } from '../../src/desktop/ptc-result-projection.js';
import type {
  LocalMavisAgentAdapter,
  LocalMavisSessionAdapter,
  LocalRuntimeToolContext,
} from '../../src/desktop/types.js';

const DIRECT: LocalRuntimeToolContext = {
  sessionId: 'sess-ptc',
  turnId: 'turn-ptc',
  toolCallId: 'call-ptc',
  agentName: 'mavis',
};
const CHILD: LocalRuntimeToolContext = { ...DIRECT, parentToolCallId: 'run-code-1' };

/** What a run_code program receives for this native result. */
function guest(toolName: string, result: ToolResult) {
  return projectDesktopPtcToolResult(result, toolName, 'builtin', {
    ...(result.programmatic ? { programmatic: result.programmatic } : {}),
  });
}

describe('isPtcChildCall', () => {
  it('is true only with a non-empty parentToolCallId', () => {
    expect(isPtcChildCall(CHILD)).toBe(true);
    expect(isPtcChildCall(DIRECT)).toBe(false);
    expect(isPtcChildCall({ parentToolCallId: '' })).toBe(false);
  });
});

describe('mavis child calls', () => {
  // A reported Session: 100 messages over 16,000 tokens; the cut data kept only { ok, command }.
  // Message text is returned in full, so these stay over the cap after the session messages projection.
  const messages = Array.from({ length: 100 }, (_, index) => ({
    msg_id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    msg_content: `message-${index}:` + '会话内容🙂'.repeat(60),
  }));
  const tool = new LocalMavisTool(
    agentAdapter(),
    undefined,
    sessionAdapter({ listMessages: async () => ({ messages, nextCursor: 'cursor-100' }) }),
  );
  const input = { command: 'session messages', args: { session_id: 'other', limit: 100 } };

  it('returns the whole response in output and data, reported complete', async () => {
    const result = await tool.execute(CHILD, input);
    const expected = {
      ok: true,
      command: 'session messages',
      response: { messages, nextCursor: 'cursor-100' },
    };

    expect(JSON.parse(result.text)).toEqual(expected);
    expect(result.text).toBe(JSON.stringify(expected, null, 2));
    expect(result.details).not.toHaveProperty('desktop_output_truncation');
    expect(result.programmatic).toMatchObject({
      data: expected,
      completeness: { truncated: false },
      uncappedOutput: true,
    });
    const program = guest('mavis', result);
    expect(program.status).toBe('complete');
    expect(program.data).toEqual(expected);
  });

  it('keeps the head+tail preview and { ok, command } data for a direct call', async () => {
    const result = await tool.execute(DIRECT, input);

    expect(result.text).toContain('desktop mavis output truncated');
    expect(result.details).toHaveProperty('desktop_output_truncation');
    expect(result.programmatic?.data).toEqual({ ok: true, command: 'session messages' });
    expect(result.programmatic).not.toHaveProperty('uncappedOutput');
    expect(guest('mavis', result).status).toBe('truncated');
  });

  it('returns a small response exactly as a direct call does', async () => {
    const small = new LocalMavisTool(
      agentAdapter(),
      undefined,
      sessionAdapter({ listMessages: async () => ({ messages: messages.slice(0, 2) }) }),
    );
    expect(await small.execute(CHILD, input)).toEqual(await small.execute(DIRECT, input));
  });
});

describe('read child calls', () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ptc-child-read-'));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function bigFile(): Promise<{ path: string; text: string; lines: string[] }> {
    // Over Pi's 2000 lines and 50 KB, the Desktop 24 KiB and one 3000-character line.
    const lines = Array.from({ length: 3000 }, (_, index) =>
      index === 1500 ? `wide-${'w'.repeat(3000)}` : `line-${index + 1}-${'x'.repeat(20)}`,
    );
    const path = join(workspace, 'big.txt');
    const text = lines.join('\n');
    await writeFile(path, text, 'utf8');
    return { path, text, lines };
  }

  it('returns the whole file without limit, reported complete', async () => {
    const { path, text, lines } = await bigFile();
    const result = await new LocalReadTool(workspace).execute(CHILD, { path });

    expect(result.text.split('\n')).toHaveLength(lines.length);
    expect(result.text).toContain(`  3000→line-3000-`);
    expect(result.text).toContain(`1501→wide-${'w'.repeat(3000)}`);
    expect(result.text).not.toContain('desktop read output truncated');
    expect(result.details).not.toHaveProperty('line_truncations');
    expect(result.details).not.toHaveProperty('truncation');
    expect(result.programmatic).toMatchObject({
      data: { kind: 'text', content: text, startLine: 1, lineCount: 3000, totalLines: 3000 },
      completeness: { truncated: false },
      uncappedOutput: true,
    });
    expect(guest('read', result).status).toBe('complete');
  });

  it('returns exactly offset/limit, past the 2000-line limit', async () => {
    const { path, lines } = await bigFile();
    const result = await new LocalReadTool(workspace).execute(CHILD, {
      path,
      offset: 11,
      limit: 2500,
    });

    expect(result.programmatic?.data).toMatchObject({
      content: lines.slice(10, 2510).join('\n'),
      startLine: 11,
      lineCount: 2500,
    });
    expect(result.programmatic?.completeness).toMatchObject({
      truncated: false,
      hasMore: true,
      nextOffset: 2511,
    });
    expect(guest('read', result).status).toBe('complete');
  });

  it('keeps both caps for a direct read', async () => {
    const { path } = await bigFile();
    const result = await new LocalReadTool(workspace).execute(DIRECT, { path });

    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DESKTOP_READ_TEXT_MAX_BYTES);
    expect(result.text).toContain('desktop read output truncated');
    expect(result.details?.truncation).toMatchObject({ truncated: true });
    expect(result.programmatic).not.toHaveProperty('uncappedOutput');
    expect(guest('read', result).status).toBe('truncated');
  });

  async function hugeFile(): Promise<string> {
    // About 8.8 MB: over PTC_CHILD_FULL_OUTPUT_MAX_BYTES.
    const path = join(workspace, 'huge.txt');
    const line = (index: number) => `line-${index + 1}-${'x'.repeat(100)}`;
    await writeFile(path, Array.from({ length: 80_000 }, (_, index) => line(index)).join('\n'));
    return path;
  }

  it('takes the direct-call page over 8 MiB without limit, with the offset to continue', async () => {
    const path = await hugeFile();
    const tool = new LocalReadTool(workspace);
    const child = await tool.execute(CHILD, { path });
    const direct = await tool.execute(DIRECT, { path });

    expect(child).toEqual(direct);
    expect(Buffer.byteLength(direct.text)).toBeLessThanOrEqual(DESKTOP_READ_TEXT_MAX_BYTES);
    expect(direct.details).toHaveProperty('desktop_output_truncation');
    expect(child.programmatic).not.toHaveProperty('uncappedOutput');
    const program = guest('read', child);
    expect(program.status).toBe('truncated');
    expect(program.truncation).toMatchObject({
      truncated: true,
      nextOffset: expect.any(Number),
      offsetUnit: 'line',
    });
  });

  it('takes the direct-call page when a limit window is over 8 MiB', async () => {
    const path = await hugeFile();
    const tool = new LocalReadTool(workspace);
    const input = { path, offset: 1, limit: 1_000_000 };
    const child = await tool.execute(CHILD, input);

    expect(child).toEqual(await tool.execute(DIRECT, input));
    expect(Buffer.byteLength(child.text)).toBeLessThanOrEqual(DESKTOP_READ_TEXT_MAX_BYTES);
    expect(guest('read', child)).toMatchObject({
      status: 'truncated',
      truncation: { truncated: true, nextOffset: expect.any(Number), offsetUnit: 'line' },
    });
  });

  it('still returns a small window of a file over 8 MiB in full', async () => {
    const path = await hugeFile();
    const result = await new LocalReadTool(workspace).execute(CHILD, {
      path,
      offset: 50_001,
      limit: 3000,
    });

    expect(result.programmatic).toMatchObject({
      data: { startLine: 50_001, lineCount: 3000 },
      completeness: { truncated: false, hasMore: true, nextOffset: 53_001 },
      uncappedOutput: true,
    });
    expect(guest('read', result).status).toBe('complete');
  });

  it('returns a small file exactly as a direct read does', async () => {
    const path = join(workspace, 'small.txt');
    await writeFile(path, 'a\nb\nc', 'utf8');
    const tool = new LocalReadTool(workspace);
    expect(await tool.execute(CHILD, { path })).toEqual(await tool.execute(DIRECT, { path }));
  });
});

describe('bash child calls', () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ptc-child-bash-'));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function nodeCommand(script: string): string {
    return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  }

  it('reads the whole output back from the full-output file, reported complete', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const command = nodeCommand(
      `for(let i=0;i<400;i++) console.log('row-'+i+'-'+'x'.repeat(90))`,
    );
    const result = await tool.execute(CHILD, { command });

    const rows = result.text.split('\n').filter((line) => line.startsWith('row-'));
    expect(rows).toHaveLength(400);
    expect(result.text).toContain('row-200-');
    expect(result.text).not.toContain('output omitted');
    expect(result.details).not.toHaveProperty('truncation');
    expect(result.details).not.toHaveProperty('desktop_output_truncation');
    expect(result.programmatic).toMatchObject({
      completeness: { truncated: false },
      uncappedOutput: true,
    });
    expect(guest('bash', result)).toMatchObject({
      status: 'complete',
      data: { status: 'complete', exitCode: 0 },
    });
  });

  it('keeps the status line after the whole output of a failing command', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const command = nodeCommand(
      `for(let i=0;i<400;i++) console.log('row-'+i+'-'+'x'.repeat(90)); process.exit(3)`,
    );
    const result = await tool.execute(CHILD, { command });

    expect(result.isError).toBe(true);
    expect(result.text.split('\n').filter((line) => line.startsWith('row-'))).toHaveLength(400);
    expect(result.text.endsWith('Command exited with code 3')).toBe(true);
    expect(guest('bash', result).data).toEqual({ status: 'complete', exitCode: 3 });
  });

  it('keeps the preview and the full-output path above 8 MiB', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    // 9 MiB in 64 KiB blocks, paced so Pi's pending file writes stay below
    // its 4 MiB buffer limit and the full output is saved completely.
    const command = nodeCommand(
      `const block=('y'.repeat(1023)+'\\n').repeat(64); let i=0; const t=setInterval(()=>{process.stdout.write(block); if(++i>=144) clearInterval(t)},2)`,
    );
    const result = await tool.execute(CHILD, { command, timeout: 60 });

    expect(result.details?.output).toMatchObject({ persistence: 'complete' });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DESKTOP_BASH_MAX_BYTES);
    expect(result.text.toLowerCase().includes('full output:')).toBe(true);
    expect(result.details?.desktop_output_truncation).toMatchObject({ truncated: true });
    expect(result.programmatic).not.toHaveProperty('uncappedOutput');
    expect(guest('bash', result).status).toBe('truncated');
  }, 60_000);

  it('keeps the preview for a direct call', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const command = nodeCommand(
      `for(let i=0;i<400;i++) console.log('row-'+i+'-'+'x'.repeat(90))`,
    );
    const result = await tool.execute(DIRECT, { command });

    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DESKTOP_BASH_MAX_BYTES);
    expect(result.text).not.toContain('row-200-');
    expect(result.details?.desktop_output_truncation).toMatchObject({ truncated: true });
    expect(result.programmatic).not.toHaveProperty('uncappedOutput');
  });
});

describe('grep child calls', () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ptc-child-grep-'));
    const lines = Array.from({ length: 600 }, (_, index) =>
      index === 300 ? `needle-wide-${'w'.repeat(3000)}` : `needle-${index}-${'x'.repeat(80)}`,
    );
    await writeFile(join(workspace, 'hits.txt'), lines.join('\n'), 'utf8');
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const input = { pattern: 'needle', output_mode: 'content' as const, limit: 1000 };

  it('returns every match line of the page in full, reported complete', async () => {
    const result = await new LocalGrepTool(workspace).execute(CHILD, input);

    expect(Buffer.byteLength(result.text)).toBeGreaterThan(DESKTOP_GREP_CONTENT_MAX_BYTES);
    expect(result.text).toContain(`hits.txt:301:needle-wide-${'w'.repeat(3000)}`);
    expect(result.text).toContain('hits.txt:600:needle-599-');
    expect(result.text).not.toContain('desktop grep output truncated');
    expect(result.details).not.toHaveProperty('linesTruncated');
    const matches = result.programmatic?.data?.matches as { text: string }[];
    expect(matches).toHaveLength(600);
    expect(matches[300]?.text).toBe(`needle-wide-${'w'.repeat(3000)}`);
    expect(result.programmatic).toMatchObject({
      completeness: { truncated: false },
      uncappedOutput: true,
    });
    expect(guest('grep', result).status).toBe('complete');
  });

  it('still stops at limit and reports the next page', async () => {
    const result = await new LocalGrepTool(workspace).execute(CHILD, { ...input, limit: 500 });

    expect(result.programmatic?.data?.matches).toHaveLength(500);
    expect(result.programmatic?.completeness).toMatchObject({
      truncated: true,
      nextOffset: 500,
      offsetUnit: 'match',
    });
  });

  it('keeps the 16 KiB cap and the line cap for a direct call', async () => {
    const result = await new LocalGrepTool(workspace).execute(DIRECT, input);

    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DESKTOP_GREP_CONTENT_MAX_BYTES);
    expect(result.details).toHaveProperty('desktop_output_truncation');
    expect(result.programmatic).not.toHaveProperty('uncappedOutput');
    expect(guest('grep', result).status).toBe('truncated');
  });
});

describe('web_fetch child calls', () => {
  const body = `HEAD-${'page text '.repeat(10_000)}-TAIL`;
  const tool = new LocalWebFetchTool({
    fetch: vi.fn().mockResolvedValue({
      content: body,
      status: 200,
      contentType: 'text/html',
      base_resp: { status_code: 0 },
    }),
  });
  const input = { url: 'https://example.test/long' };

  it('returns the whole body in output and data, reported complete', async () => {
    const result = await tool.execute(CHILD, input);

    expect(result.text).toBe(body);
    expect(result.details).not.toHaveProperty('token_truncated');
    expect(result.details).not.toHaveProperty('truncated');
    expect(result.programmatic).toMatchObject({
      data: { content: body },
      completeness: { truncated: false },
      uncappedOutput: true,
    });
    expect(guest('web_fetch', result).status).toBe('complete');
  });

  it('keeps the 16,000-token cut for a direct call', async () => {
    const result = await tool.execute(DIRECT, input);

    expect(result.text).toContain('[web_fetch response truncated');
    expect(result.details).toMatchObject({ truncated: true, token_truncated: true });
    expect(guest('web_fetch', result).status).toBe('truncated');
  });
});

describe('memory child calls', () => {
  const text = 'FIRST_FACT\n' + '记忆🙂'.repeat(20_000) + '\nLATEST_FACT';
  const data = { ok: true, target: 'main', operation: 'read', content: text, sizeBytes: 1 };
  const tool = new LocalMemoryTool({
    execute: async () => ({ text, details: { ok: true, target: 'main' }, data }),
  });
  const input = { target: 'main' as const, operation: 'read' as const };

  it('returns the whole text and data, reported complete', async () => {
    const result = await tool.execute(CHILD, input);

    expect(Buffer.byteLength(text)).toBeGreaterThan(MEMORY_TOOL_OUTPUT_MAX_BYTES);
    expect(result.text).toBe(text);
    expect(result.details).toEqual({ kind: 'memory', ok: true, target: 'main' });
    expect(result.programmatic).toMatchObject({
      data,
      completeness: { truncated: false },
      uncappedOutput: true,
    });
    expect(guest('memory', result).status).toBe('complete');
  });

  it('keeps the head+tail cut and metadata-only data for a direct call', async () => {
    const result = await tool.execute(DIRECT, input);

    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(MEMORY_TOOL_OUTPUT_MAX_BYTES);
    expect(result.programmatic?.data).not.toHaveProperty('content');
    expect(guest('memory', result).status).toBe('truncated');
  });
});

function agentAdapter(): LocalMavisAgentAdapter {
  return {
    listAgents: async () => ({ agents: [] }),
    createAgent: async () => ({ name: 'created' }),
    getAgent: async ({ name }) => ({ agent: { name } }),
    updateAgent: async ({ name }) => ({ success: true, agent: { name } }),
    deleteAgent: async () => ({ success: true }),
    resolveAgentReadScope: async (requestedName) => ({ canonicalName: requestedName }),
    resolveAgentWriteTarget: async (requestedName) => requestedName,
    requireExactAgentKey: async (requestedName) => requestedName,
  };
}

function sessionAdapter(overrides: Partial<LocalMavisSessionAdapter>): LocalMavisSessionAdapter {
  return {
    listSessions: async () => ({ sessions: [] }),
    getSession: async ({ sessionId }) => ({ session: { sessionId } }),
    updateSession: async ({ sessionId }) => ({ success: true, session: { sessionId } }),
    listMessages: async () => ({ messages: [] }),
    interruptSession: async () => ({ outcome: 'not_running' }),
    createSession: async (req) => ({
      sessionId: 'mvs_created',
      agentName: req.agentName,
      turnId: 'turn-created',
      mode: 'started' as const,
    }),
    sendSession: async ({ sessionId }) => ({
      sessionId,
      turnId: 'turn-default',
      status: 'completed',
      content: '',
    }),
    ...overrides,
  };
}
