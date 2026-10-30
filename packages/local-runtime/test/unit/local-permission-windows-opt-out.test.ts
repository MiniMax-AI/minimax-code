import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWindowsTrashExecution } from '@mavis/permission';
import type { LocalRuntimeConfig } from '../../src/config/types.js';
import { LocalPermissionFacade } from '../../src/permissions/facade.js';
import { LocalPermissionRuleStore } from '../../src/permissions/rules.js';
import { beforeLocalToolCall } from '../../src/api/routes/permissions.js';
import type { LocalPermissionRouteContext } from '../../src/api/routes/permissions.js';
import { LocalPermissionApprovalService } from '../../src/api/local-permission-approval-service.js';
import type { LocalSessionRecord } from '../../src/sessions/controller.js';
import {
  TRASH_CMD_LAUNCHER_CONTENT,
  TRASH_SCRIPT_WIN_CONTENT,
} from '../../src/infra/trash-script-win.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  enabled?: boolean,
  mode: LocalRuntimeConfig['permissionMode'] = 'off',
  platform: NodeJS.Platform = 'win32',
  options: {
    seedTrash?: boolean;
    shellFamily?: 'cmd' | 'powershell';
    trashAvailable?: boolean;
  } = {},
) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'windows-safety-opt-out-'));
  roots.push(dataDir);
  if (options.seedTrash) {
    const binDir = path.join(dataDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'mavis-trash.js'), TRASH_SCRIPT_WIN_CONTENT);
    writeFileSync(path.join(binDir, 'mavis-trash.cmd'), TRASH_CMD_LAUNCHER_CONTENT);
  }
  const config = { dataDir, provider: {}, permissionMode: mode } as LocalRuntimeConfig;
  const rules = new LocalPermissionRuleStore(() => dataDir);
  const facade = new LocalPermissionFacade({
    ruleStore: rules,
    configGetter: () => config,
    getSessionById: async () => undefined,
    getLocalAgent: async () => ({ defaultWorkspaceDir: String.raw`C:\workspace` }),
    platform,
    shellFamily: options.shellFamily,
    trashRuntimeProbe: () => options.trashAvailable ?? true,
    skipWindowsHardSafetyChecks: enabled,
  });
  const approval = new LocalPermissionApprovalService({
    agentName: 'mavis',
    nowMs: Date.now,
    permissionRules: rules,
    publishGlobalEvent: () => {},
  });
  const begin = vi.spyOn(approval, 'begin');
  const ctx: LocalPermissionRouteContext = {
    agentName: 'mavis',
    configGetter: () => config,
    nowMs: Date.now,
    permissionRules: rules,
    permissionService: facade,
    approvalService: approval,
    emitBusEvent: () => {},
  };
  const execute = vi.fn(async (_input: unknown) => ({ output: 'mock next step' }));
  async function dispatch(tool: string, args: Record<string, unknown>) {
    const call = { assistantMessage: {}, toolCall: { name: tool }, args, context: {} };
    const blocked = await beforeLocalToolCall(
      ctx,
      { sessionId: 'opt-out-test', agentName: 'mavis' } as LocalSessionRecord,
      'turn-test',
      call as never,
    );
    if (!blocked) await execute(call.args);
    return blocked;
  }
  return { facade, rules, dispatch, execute, begin, config };
}

describe('Windows hard-safety opt-out', () => {
  const commands = [
    // Ambiguous drive-relative path and a Python deletion-literal false positive.
    'Set-Content w:shd example',
    `python -c "d = {'x': 1}; del d['x']"`,
    String.raw`Set-Content -Path C:\Windows\Temp\example.txt -Value example`,
  ];
  it.each(commands)('only proceeds after explicit opt-out: %s', async (command) => {
    for (const enabled of [undefined, false, true]) {
      const f = fixture(enabled);
      const blocked = await f.dispatch('bash', { command });
      expect(Boolean(blocked), blocked?.reason).toBe(enabled !== true);
      expect(f.execute).toHaveBeenCalledTimes(enabled === true ? 1 : 0);
      if (enabled === true) expect(f.execute).toHaveBeenCalledWith({ command });
      expect(f.begin).not.toHaveBeenCalled();
    }
  });

  it.each([
    // TUI currently leaves shellFamily unspecified; native deletes also cover explicit shells below.
    [undefined, String.raw`rm -rf C:\workspace\temporary`],
    ['powershell', String.raw`Remove-Item -Recurse -Force C:\workspace\temporary`],
    ['powershell', String.raw`ri C:\workspace\temporary`],
    ['cmd', String.raw`del /f /q C:\workspace\temporary`],
    ['cmd', String.raw`erase C:\workspace\temporary`],
    ['cmd', String.raw`rmdir /s /q C:\workspace\temporary`],
    ['cmd', String.raw`rd /s C:\workspace\temporary`],
  ] as const)('preserves the %s trash rewrite at execution: %s', async (shellFamily, command) => {
    for (const enabled of [false, true]) {
      for (const mode of ['off', 'bypassPermissions'] as const) {
        const f = fixture(enabled, mode, 'win32', { seedTrash: true, shellFamily });
        const blocked = await f.dispatch('bash', { command });
        expect(blocked, blocked?.reason).toBeUndefined();
        expect(f.execute).toHaveBeenCalledOnce();
        const executed = f.execute.mock.calls[0][0] as Record<string, unknown>;
        expect(executed.command).not.toBe(command);
        if (command.startsWith('rm ')) {
          expect(executed.command).toContain(
            path.win32.join(f.config.dataDir, 'bin', 'mavis-trash.cmd'),
          );
          expect(executed.command).toContain(String.raw`C:\workspace\temporary`);
        } else {
          expect(executed.command).toBe('mavis-trash --');
          expect(readWindowsTrashExecution(executed)?.targets).toEqual([
            String.raw`C:\workspace\temporary`,
          ]);
        }
        expect(f.begin).not.toHaveBeenCalled();
      }
    }
  });

  it('preserves the rm rewrite decision with an explicit Windows shell', async () => {
    for (const enabled of [false, true]) {
      for (const shellFamily of ['cmd', 'powershell'] as const) {
        const f = fixture(enabled, 'off', 'win32', { seedTrash: true, shellFamily });
        const command = String.raw`rm -rf C:\workspace\temporary`;
        // Existing execution-plan validation rejects this legacy rewrite with an explicit
        // Windows shell. Check the unchanged rewrite decision without masking that failure.
        const result = await f.facade.checkPermissionRaw({
          toolName: 'bash',
          agentName: 'mavis',
          input: { command },
        });
        expect(result.behavior).toBe('allow');
        expect(result.rewrittenInput?.command).toContain(
          path.win32.join(f.config.dataDir, 'bin', 'mavis-trash.cmd'),
        );
        expect(result.rewrittenInput?.command).toContain(String.raw`C:\workspace\temporary`);
      }
    }
  });

  it.each([
    String.raw`rm -rf C:\workspace\temporary`,
    String.raw`Remove-Item -Recurse -Force C:\workspace\temporary`,
  ])('still blocks deletion when trash is missing or unhealthy: %s', async (command) => {
    for (const enabled of [false, true]) {
      for (const seedTrash of [false, true]) {
        const f = fixture(enabled, 'off', 'win32', {
          seedTrash,
          trashAvailable: false,
          shellFamily: 'powershell',
        });
        const blocked = await f.dispatch('bash', { command });
        expect(blocked).toMatchObject({ block: true });
        expect(blocked?.reason).toMatch(/mavis-trash.*unavailable/i);
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.begin).not.toHaveBeenCalled();
      }
    }
  });

  it.each([
    String.raw`mavis-trash -rf C:\workspace\temporary`,
    String.raw`C:\untrusted\mavis-trash.cmd -rf C:\workspace\temporary`,
    String.raw`Write-Output start; Remove-Item -Recurse -Force C:\workspace\temporary`,
  ])('does not execute an untrusted launcher or an unsupported delete: %s', async (command) => {
    for (const enabled of [false, true]) {
      const f = fixture(enabled, 'off', 'win32', { seedTrash: true });
      expect(await f.dispatch('bash', { command })).toMatchObject({ block: true });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.begin).not.toHaveBeenCalled();
    }
  });

  it('also skips the duplicate Windows path check without skipping normal permission rules', async () => {
    const f = fixture(true, 'default');
    const input = { file_path: String.raw`C:\Windows\Temp\example.txt`, content: 'example' };
    // The Windows hard deny is gone; generic path resolution follows the host OS.
    expect((await f.facade.checkPermission({ toolName: 'write', input })).behavior).not.toBe(
      'deny',
    );
    await f.rules.applyUpdate({
      type: 'addRules',
      source: 'global',
      destination: 'global',
      behavior: 'allow',
      rules: [{ toolName: 'write' }],
    });
    expect((await f.facade.checkPermission({ toolName: 'write', input })).behavior).toBe('allow');
    await f.rules.applyUpdate({
      type: 'addRules',
      source: 'global',
      destination: 'global',
      behavior: 'deny',
      rules: [{ toolName: 'write' }],
    });
    expect((await f.facade.checkPermission({ toolName: 'write', input })).behavior).toBe('deny');
  });

  it('does not accept opt-out via tool arguments or a live config change', async () => {
    const f = fixture(false);
    f.config.skipWindowsHardSafetyChecks = true;
    expect(
      await f.dispatch('bash', {
        command: commands[2],
        skipWindowsHardSafetyChecks: true,
      }),
    ).toMatchObject({ block: true });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin'] as const)(
    'retains the %s trash health boundary',
    async (platform) => {
      const f = fixture(true, 'off', platform);
      const blocked = await f.dispatch('bash', { command: 'rm -rf ./temporary' });
      expect(blocked).toMatchObject({ block: true });
      expect(blocked?.reason).toMatch(/trash/i);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it('retains UNC protection under the normal permission pipeline', async () => {
    const f = fixture(true, 'bypassPermissions');
    expect(
      await f.dispatch('read', { file_path: String.raw`\\server\share\secret.txt` }),
    ).toMatchObject({ block: true });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
