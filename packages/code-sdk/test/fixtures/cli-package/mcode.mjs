#!/usr/bin/env node
// Test double for `mcode`. Replays recorded `mcode exec --output-format stream-json` output.
//
// Behaviour is driven by environment variables so tests can pass them through MCode({ env }):
//   FAKE_MCODE_VERSION   output of `--version` (default 0.7.0)
//   FAKE_MCODE_VERSION_LOG  file that gets one line appended per `--version` call
//   FAKE_MCODE_FIXTURE   JSONL file to replay on stdout
//   FAKE_MCODE_EXIT      exit code after replay (default 0)
//   FAKE_MCODE_STDERR    text written to stderr before exiting
//   FAKE_MCODE_RECORD    file that receives { argv, stdin, env, promptFiles } as JSON
//   FAKE_MCODE_MODE      'normal' | 'wait-sigint' | 'ignore-signals' | 'hang'
//   FAKE_MCODE_SPLIT     non-normal modes: lines replayed before waiting (default 3)
//   FAKE_MCODE_PREFIX    raw text written to stdout before the fixture
//   FAKE_MCODE_GRANDCHILD_PID  normal mode: before exiting, spawn a long-lived grandchild that
//                        inherits stdout / stderr and write its pid to this file
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const argv = process.argv.slice(2);

if (argv[0] === '--version') {
  if (env.FAKE_MCODE_VERSION_LOG) appendFileSync(env.FAKE_MCODE_VERSION_LOG, 'version\n');
  process.stdout.write(`${env.FAKE_MCODE_VERSION ?? '0.7.0'}\n`);
  process.exit(0);
}

const stdinChunks = [];
process.stdin.on('data', (chunk) => stdinChunks.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(stdinChunks).toString('utf8');
  if (env.FAKE_MCODE_RECORD) {
    const promptFiles = {};
    for (const arg of argv) {
      const match = /^--((?:append-)?system-prompt-file)=(.*)$/u.exec(arg);
      if (match) promptFiles[match[1]] = readFileSync(match[2], 'utf8');
    }
    const recordedEnv = { MINIMAX_DATA_DIR: env.MINIMAX_DATA_DIR ?? null };
    writeFileSync(
      env.FAKE_MCODE_RECORD,
      JSON.stringify({ argv, stdin, env: recordedEnv, promptFiles }),
    );
  }
  run();
});

function run() {
  const lines = env.FAKE_MCODE_FIXTURE
    ? readFileSync(env.FAKE_MCODE_FIXTURE, 'utf8').split('\n').filter(Boolean)
    : [];
  const exitCode = Number(env.FAKE_MCODE_EXIT ?? '0');
  const mode = env.FAKE_MCODE_MODE ?? 'normal';
  if (env.FAKE_MCODE_PREFIX) process.stdout.write(env.FAKE_MCODE_PREFIX);

  const finish = (rest, code) => {
    for (const line of rest) process.stdout.write(`${line}\n`);
    if (env.FAKE_MCODE_STDERR) process.stderr.write(`${env.FAKE_MCODE_STDERR}\n`);
    process.stdout.end(() => process.exit(code));
  };

  if (mode === 'normal') {
    if (env.FAKE_MCODE_GRANDCHILD_PID) {
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      writeFileSync(env.FAKE_MCODE_GRANDCHILD_PID, String(grandchild.pid));
      grandchild.unref();
    }
    finish(lines, exitCode);
    return;
  }
  const split = Number(env.FAKE_MCODE_SPLIT ?? '3');
  const keepAlive = setInterval(() => {}, 1_000);
  // Install handlers before replaying, so a consumer that saw an event can signal safely.
  if (mode === 'wait-sigint') {
    process.once('SIGINT', () => {
      clearInterval(keepAlive);
      finish(lines.slice(split), 130);
    });
  } else if (mode === 'ignore-signals') {
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  }
  // 'hang' keeps default signal handling and never finishes on its own.
  for (const line of lines.slice(0, split)) process.stdout.write(`${line}\n`);
}
