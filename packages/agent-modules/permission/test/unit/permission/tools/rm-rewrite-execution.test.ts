import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRASH_SCRIPT_CONTENT } from '../../../../../../local-runtime/src/infra/trash-script.js';
import { createToolPermissionContext } from '../../../../src/context.js';
import { createPermissionExecutionPlan } from '../../../../src/execution-plan.js';
import { BashToolPermissionChecker } from '../../../../src/tools/bash-checker.js';

// Run the actual permission rewrite, validated execution plan and trash script.
// Native rm is the reference; every file and trash destination belongs to this fixture.
function execute(command: string, rewrite: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'rm-rewrite-'));
  try {
    const dataDir = join(root, 'runtime');
    const home = join(root, 'home');
    const work = join(root, 'work');
    mkdirSync(join(dataDir, 'bin'), { recursive: true });
    mkdirSync(join(home, '.Trash'), { recursive: true });
    mkdirSync(work);
    for (const file of ['old', 'a.tmp', 'b.tmp', '2>&1', '-f', '--', 'keep']) {
      writeFileSync(join(work, file), 'fixture');
    }
    writeFileSync(join(dataDir, 'bin', 'mavis-trash'), TRASH_SCRIPT_CONTENT, { mode: 0o755 });
    let effectiveCommand = command;
    if (rewrite) {
      const context = createToolPermissionContext({
        workingDirectory: root,
        dataDir,
        homeDir: home,
        platform: process.platform,
      });
      const decision = new BashToolPermissionChecker().checkPermissions(
        'bash',
        { command },
        context,
      );
      expect(decision?.behavior).toBe('allow');
      const plan = createPermissionExecutionPlan({
        toolName: 'bash',
        input: { command },
        rewrittenInput: decision?.rewrittenInput,
        context: { workingDirectory: root, homeDir: home },
      });
      effectiveCommand = String(plan.effectiveInput.command);
    }
    const result = spawnSync('bash', ['-c', effectiveCommand], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: join(home, '.local/share'),
        MAVIS_TRASH_FORCE_MV: '1',
        TARGET: './old',
      },
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      remaining: readdirSync(work).sort(),
      stdoutMarkers: result.stdout.split('\n').filter((line) => /^(DONE|AFTER)$/.test(line)),
      stdoutHasMissing: result.stdout.includes('missing'),
      stderrHasMissing: result.stderr.includes('missing'),

    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')(
  'rm cleanup rewrite keeps command sequencing',
  () => {
    it.each([
      // Missing cleanup paths before cd/mkdir/export: the trajectory failure.
      'cd ./work && rm -rf ./missing && mkdir -p ./export && cd ./export && echo DONE',
      'cd ./work && rm -f ./missing && echo DONE',
      'cd ./work && rm -rf ./missing; echo AFTER',
      'cd ./work && rm -f ./old ./missing && echo DONE',
      // FD redirection stays shell syntax after --, including pipelines.
      'cd ./work && rm -- ./old 2>&1 && echo DONE',
      'cd ./work && rm -- ./old 2>&1 | cat; echo AFTER',
      'cd ./work && rm -f -- ./old 2>&1 ./missing && echo DONE',
      'cd ./work && rm -- ./missing 2>&1; echo AFTER',
      // Real errors still stop &&; quoted/escaped syntax remains a filename.
      'cd ./work && rm ./missing && echo DONE',
      "cd ./work && rm -- '2>&1' && echo DONE",
      String.raw`cd ./work && rm -- 2\>\&1 && echo DONE`,
      'cd ./work && rm -fi ./missing && echo DONE',
      'cd ./work && rm -if ./missing && echo DONE',
    ])('%s', (command) => {
      expect(execute(command, true)).toEqual(execute(command, false));
    });

    it.each(['./*.tmp', '"$TARGET"', '"$(rm -f ./keep; printf ./old)"'])(
      'keeps unsupported expansion %s literal without hiding failures',
      (target) => {
      const result = execute(`cd ./work && rm -f ${target} && echo DONE`, true);
      expect(result.status).not.toBe(0);
      expect(result.remaining).toEqual(expect.arrayContaining(['a.tmp', 'old', 'keep']));
      expect(result.stdoutMarkers).toEqual([]);
    });

    it('keeps protected directories and sibling files even with force', () => {
      const result = execute('cd ./work && rm -rf ./old . && echo DONE', true);
      expect(result.status).not.toBe(0);
      expect(result.remaining).toContain('old');
      expect(result.stdoutMarkers).toEqual([]);
    });
  },
);
