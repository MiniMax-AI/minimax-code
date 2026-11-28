import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readProjectMcpConfig } from './project-config.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function parse(mcpServers: unknown, env: Record<string, string> = {}) {
  for (const name of ['BIN', 'ARG', 'SECRET', 'BASE', 'MISSING']) vi.stubEnv(name, env[name]);
  const root = await mkdtemp(join(tmpdir(), 'project-mcp-parse-'));
  roots.push(root);
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers }));
  return readProjectMcpConfig(root);
}
it('expands supported fields and strips runtime-owned metadata', async () => {
  const doc = await parse(
    {
      local: {
        command: `\${BIN}`,
        args: [`\${ARG:-fallback}`, ''],
        env: { KEY: `\${SECRET}` },
        builtin: true,
        metadata: { mockResponses: { danger: {} } },
        tools: [{ name: 'danger' }],
      },
      remote: {
        type: 'http',
        url: `\${BASE}/mcp`,
        headers: { Authorization: `Bearer \${SECRET}` },
      },
    },
    { BIN: 'node', SECRET: 'secret', BASE: 'https://example.test' },
  );
  expect(doc.entries[0]?.config).toEqual({
    command: 'node',
    args: ['fallback', ''],
    env: { KEY: 'secret' },
    type: 'stdio',
    enabled: true,
    configured: true,
    builtin: false,
  });
  expect(doc.entries[1]?.config?.headers).toEqual({ Authorization: 'Bearer secret' });
  expect((await parse({ local: { command: `\${BIN}` } }, { BIN: 'node' })).digest).not.toBe(
    (await parse({ local: { command: `\${BIN}` } }, { BIN: 'python' })).digest,
  );
});
it('isolates bad entries, rejects reserved names and never echoes secret values', async () => {
  const doc = await parse({
    good: { command: 'node' },
    bad: { url: 'secret-value', headers: { Key: `\${MISSING}` } },
    matrix: { command: 'node' },
    invalid: { command: 'node', args: [123] },
  });
  expect(doc.entries[0]?.config?.command).toBe('node');
  expect(doc.entries.slice(1).every((entry) => entry.error && !entry.config)).toBe(true);
  expect(JSON.stringify(doc.entries.map((entry) => entry.error))).not.toContain('secret-value');
  expect((await parse({ env: { command: `\${MISSING}` } })).entries[0]?.error).toContain('MISSING');
});
it('rejects malformed documents', async () => {
  expect((await parse([])).error).toContain('Cannot read');
});
it('preserves distinct raw names that used to collide after normalization', async () => {
  const document = await parse({
    'same name': { command: 'node' },
    'same-name': { command: 'python' },
  });
  expect(document.error).toBeUndefined();
  expect(document.entries).toEqual([
    { name: 'same name', config: expect.objectContaining({ command: 'node' }) },
    { name: 'same-name', config: expect.objectContaining({ command: 'python' }) },
  ]);
});
it('reads only the workspace file and never rewrites it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-mcp-reader-'));
  roots.push(root);
  expect((await readProjectMcpConfig(root)).digest).toBe('missing');
  const path = join(root, '.mcp.json');
  const text = '{ "mcpServers": { "repo": { "command": "node" } } }';
  await writeFile(path, text);
  expect((await readProjectMcpConfig(root)).entries).toHaveLength(1);
  expect(await readFile(path, 'utf8')).toBe(text);
  await writeFile(path, 'not json');
  expect((await readProjectMcpConfig(root)).error).toContain('Cannot read');
});
it('rejects symlinks outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-mcp-root-'));
  roots.push(root);
  const outside = await mkdtemp(join(tmpdir(), 'project-mcp-outside-'));
  roots.push(outside);
  await writeFile(join(outside, 'config'), JSON.stringify({ mcpServers: {} }));
  await symlink(join(outside, 'config'), join(root, '.mcp.json'));
  expect((await readProjectMcpConfig(root)).error).toContain('Cannot read');
});
it('limits project OAuth to the callback port and keeps it exclusive with Authorization', async () => {
  const url = 'https://mcp.example.test/mcp';
  const doc = await parse({
    port: { type: 'http', url, oauth: { callbackPort: 19876 } },
    client: { type: 'http', url, oauth: { clientId: 'repo-controlled' } },
    metadata: { type: 'http', url, oauth: { authServerMetadataUrl: 'https://as.test/x' } },
    range: { type: 'http', url, oauth: { callbackPort: 80 } },
    both: { type: 'http', url, headers: { AUTHORIZATION: 'Bearer x' }, oauth: {} },
  });
  const byName = Object.fromEntries(doc.entries.map((entry) => [entry.name, entry]));
  expect(byName['port']?.config?.oauth).toEqual({ callbackPort: 19876 });
  for (const name of ['client', 'metadata', 'range', 'both']) {
    expect(byName[name]?.config, name).toBeUndefined();
    expect(byName[name]?.error, name).toMatch(/oauth/iu);
    expect(byName[name]?.error, name).not.toContain('repo-controlled');
  }
});
