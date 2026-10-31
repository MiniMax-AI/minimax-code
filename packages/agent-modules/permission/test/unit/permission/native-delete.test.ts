import { describe, expect, it } from 'vitest';

import { applyPermissionUpdate, createToolPermissionContext } from '../../../src/context.js';
import type { ToolPermissionContextConfig } from '../../../src/context.js';
import { matchHardBlockedBash } from '../../../src/classifier/dangerous-patterns.js';
import { createPermissionExecutionPlan } from '../../../src/execution-plan.js';
import { BashToolPermissionChecker } from '../../../src/tools/bash-checker.js';
import { checkBashPermission } from '../../../src/tools/bash-permission.js';
import { checkDangerousPatterns } from '../../../src/tools/bash-safety-scan.js';
import { readWindowsTrashExecution } from '../../../src/windows-trash-execution.js';
import type { PermissionRule } from '../../../src/types.js';

const checker = new BashToolPermissionChecker();
const wholeRule = (ruleBehavior: PermissionRule['ruleBehavior']): PermissionRule => ({
  source: 'global',
  ruleBehavior,
  ruleValue: { toolName: 'bash' },
});

function check(command: string, overrides: Partial<ToolPermissionContextConfig> = {}) {
  return checker.checkPermissions(
    'bash',
    { command },
    createToolPermissionContext({
      workingDirectory: '/workspace',
      dataDir: '/data',
      homeDir: '/home/user',
      platform: 'linux',
      shellFamily: 'posix',
      ...overrides,
    }),
  );
}

describe('native delete permission policy', () => {
  it('defaults to recoverable deletion and retains opt-in across rule updates', () => {
    const base = { workingDirectory: '/workspace', dataDir: '/data', homeDir: '/home/user' };
    expect(createToolPermissionContext(base).nativeDelete).toBe(false);
    const context = createToolPermissionContext({ ...base, nativeDelete: true });
    expect(
      applyPermissionUpdate(context, {
        type: 'addRules',
        source: 'global',
        behavior: 'allow',
        rules: [{ toolName: 'read' }],
      }).nativeDelete,
    ).toBe(true);
    expect(check('rm ./old.txt')?.rewrittenInput?.command).toContain('mavis-trash --rm-compatible ./old.txt');
  });

  it.each(['default', 'auto', 'bypassPermissions'] as const)(
    '%s uses ordinary permissions without rewriting native rm',
    (mode) => {
      const result = check('rm ./old.txt', { mode, nativeDelete: true });
      expect(result?.behavior).toBe(mode === 'bypassPermissions' ? 'allow' : 'ask');
      expect(result?.rewrittenInput).toBeUndefined();
    },
  );

  it.each(['allow', 'ask', 'deny'] as const)(
    'preserves an explicit %s rule without adding a rewrite',
    (behavior) => {
      const result = check('rm ./old.txt', { nativeDelete: true, rules: [wholeRule(behavior)] });
      expect(result?.behavior).toBe(behavior);
      expect(result?.rewrittenInput).toBeUndefined();
    },
  );

  it('does not add a secondary rewrite when another path needs approval', () => {
    const result = check('rm ./old.txt; echo x > /outside/out.txt', { nativeDelete: true });
    expect(result?.behavior).toBe('ask');
    expect(result?.rewrittenInput).toBeUndefined();
  });

  it.each([
    '/bin/rm ./old.txt',
    'bash -c "rm ./old.txt"',
    'python3 -c "import os; os.remove(\'old.txt\')"',
    "node -e \"require('fs').unlinkSync('old.txt')\"",
    'find . -name old.txt -delete',
  ])('allows %s under bypass without recoverable-delete enforcement', (command) => {
    const result = check(command, { nativeDelete: true, mode: 'bypassPermissions' });
    expect(result?.behavior).toBe('allow');
    expect(result?.rewrittenInput).toBeUndefined();
  });

  it.each([
    'rm ./old.txt; dd if=/dev/zero of=/dev/sda',
    'rm ./old.txt; shred secret.txt',
    'rm -rf /',
  ])('retains general hard denial for %s', (command) => {
    const result = check(command, {
      nativeDelete: true,
      mode: 'bypassPermissions',
      rules: [wholeRule('allow')],
    });
    expect(result?.behavior).toBe('deny');
    expect(result?.rewrittenInput).toBeUndefined();
  });

  it('excludes recycling patterns before looking for later dangerous matches', () => {
    expect(
      matchHardBlockedBash('del old.txt; vssadmin delete shadows', {
        nativeDelete: true,
      })?.category,
    ).toBe('ransomware-indicator');
    expect(checkDangerousPatterns('/bin/rm old.txt', { nativeDelete: true })).toBeNull();
    expect(
      checkDangerousPatterns('/bin/rm old.txt; sudo reboot', {
        nativeDelete: true,
      }),
    ).toMatch(/sudo/);
    expect(checkDangerousPatterns('/bin/rm old.txt')).toBe('rm via absolute path');
  });

  it.each(['del C:\\workspace\\old.txt', 'Remove-Item -LiteralPath C:\\workspace\\old.txt'])(
    'leaves Windows %s unchanged with no trash marker',
    (command) => {
      const result = check(command, {
        nativeDelete: true,
        mode: 'bypassPermissions',
        platform: 'win32',
        shellFamily: command.startsWith('del') ? 'cmd' : 'powershell',
        workingDirectory: 'C:\\workspace',
      });
      expect(result?.behavior).toBe('allow');
      expect(result?.rewrittenInput).toBeUndefined();
      expect(readWindowsTrashExecution(result?.rewrittenInput)).toBeUndefined();
    },
  );

  it('keeps default Windows deletion recoverable', () => {
    const result = check('del C:\\workspace\\old.txt', {
      platform: 'win32',
      shellFamily: 'cmd',
      workingDirectory: 'C:\\workspace',
    });
    expect(result?.behavior).toBe('allow');
    expect(readWindowsTrashExecution(result?.rewrittenInput)?.targets).toEqual([
      'C:\\workspace\\old.txt',
    ]);
  });

  it.each(['del', 'erase', 'rd', 'rmdir'])(
    'treats PowerShell %s as Remove-Item in both deletion modes',
    (alias) => {
      const command = `${alias} 'C:\\workspace\\old.txt'`;
      const windows = {
        platform: 'win32' as const,
        shellFamily: 'powershell' as const,
        workingDirectory: 'C:\\workspace',
      };
      const recoverable = check(command, windows);
      expect(recoverable?.behavior).toBe('allow');
      expect(readWindowsTrashExecution(recoverable?.rewrittenInput)?.targets).toEqual([
        'C:\\workspace\\old.txt',
      ]);

      const native = check(command, {
        ...windows,
        nativeDelete: true,
        mode: 'bypassPermissions',
      });
      expect(native?.behavior).toBe('allow');
      expect(native?.rewrittenInput).toBeUndefined();
    },
  );

  it.each([
    { target: 'C:/workspace/old.txt', rules: [], behavior: 'allow', outside: false },
    { target: 'C:/outside/old.txt', rules: [wholeRule('ask')], behavior: 'ask', outside: true },
    { target: 'C:/outside/old.txt', rules: [wholeRule('allow')], behavior: 'allow', outside: true },
  ])('keeps a single PowerShell rm recoverable: $target / $behavior', ({ target, rules, behavior, outside }) => {
    const context = createToolPermissionContext({
      workingDirectory: 'C:\\workspace',
      dataDir: 'C:\\runtime',
      homeDir: 'C:\\Users\\alice',
      platform: 'win32',
      shellFamily: 'powershell',
      nativeDelete: false,
      rules,
    });
    const input = { command: `rm ${target}` };
    const result = checker.checkPermissions('bash', input, context);
    const plan = createPermissionExecutionPlan({
      toolName: 'bash',
      input,
      rewrittenInput: result?.rewrittenInput,
      shell: 'powershell',
      context,
    });
    const targets = [target.replaceAll('/', '\\')];
    expect(result?.behavior).toBe(behavior);
    expect(plan.effectiveInput.command).toBe('mavis-trash --');
    expect(plan.transforms).toEqual([{ type: 'recoverable-delete', targets }]);
    expect(readWindowsTrashExecution(plan.effectiveInput)).toEqual({
      targets,
      ...(outside ? { allowOutsideWorkspaceFiles: true } : {}),
    });
  });

  it.each([
    'git diff --quiet && rm C:/workspace/old.txt',
    'git diff --quiet || rm C:/workspace/old.txt',
    'rm C:/workspace/old.txt; echo done',
    'rm C:/workspace/old.txt | echo done',
    'rm C:/workspace/old.txt\necho done',
    'git diff --quiet && rm C:/outside/old.txt',
  ])('rejects a PowerShell rm alias rewrite that would discard control flow: %s', (command) => {
    const context = createToolPermissionContext({
      workingDirectory: 'C:\\workspace',
      dataDir: 'C:\\runtime',
      homeDir: 'C:\\Users\\alice',
      platform: 'win32',
      shellFamily: 'powershell',
      nativeDelete: false,
    });
    const decision = checkBashPermission(command, [], context);
    expect(decision.reason.type).toBe('subcommandResults');
    if (decision.reason.type === 'subcommandResults') {
      expect(
        [...decision.reason.reasons.values()].some(
          (result) => result.reason.type === 'recoverableDeleteRewrite',
        ),
      ).toBe(true);
    }

    const input = { command };
    const result = checker.checkPermissions('bash', input, context);
    const plan = createPermissionExecutionPlan({
      toolName: 'bash', input, rewrittenInput: result?.rewrittenInput,
      shell: 'powershell', context,
    });
    expect(plan.effectiveInput).toEqual(input);
    expect(plan.transforms).toEqual([]);
    expect(readWindowsTrashExecution(plan.effectiveInput)).toBeUndefined();
    expect(result?.behavior).toBe('deny');
    expect(result?.rewrittenInput).toBeUndefined();
  });

  it.each(['default', 'auto', 'bypassPermissions'] as const)(
    '%s cannot authorize a PowerShell compound rm by discarding its condition',
    (mode) => {
      const result = check('git diff --quiet && rm C:/workspace/old.txt', {
        mode, nativeDelete: false, rules: [wholeRule('allow')],
        platform: 'win32', shellFamily: 'powershell', workingDirectory: 'C:\\workspace',
      });
      expect(result?.behavior).toBe('deny');
      expect(result?.rewrittenInput).toBeUndefined();
    },
  );

  it('does not allow a Windows compound command merely because its first segment deletes', () => {
    const result = check('del old.txt; vssadmin delete shadows', {
      nativeDelete: true,
      mode: 'bypassPermissions',
      platform: 'win32',
      shellFamily: 'cmd',
    });
    expect(result?.behavior).toBe('deny');
  });
});
