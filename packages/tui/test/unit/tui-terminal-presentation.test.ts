import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '../../src/tui/engine/public.js';
import { createObservedTerminal } from '../../src/tui/platform/observed-terminal.js';
import { detectTerminalCapabilities } from '../../src/tui/platform/terminal-capabilities.js';
import {
  buildTuiTerminalNotificationSequences,
  TuiTerminalNotifications,
} from '../../src/tui/platform/terminal-notifications.js';
import { formatTuiTerminalTitle, TuiTerminalTitle } from '../../src/tui/platform/terminal-title.js';
import {
  TuiTerminalProgramStatus,
  type TuiProgramStatus,
} from '../../src/tui/platform/terminal-program-status.js';

const capabilities = (
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = 'linux',
  isTTY = true,
) => detectTerminalCapabilities({ platform, isTTY, env });

describe('terminal title ownership', () => {
  it('sanitizes session names and preserves status and configured order', () => {
    const input = {
      title: '\u001b[31m修复\u001b[0m\n登录\u0007\u202e',
      sessionId: 'session-1',
      workspace: '/workspace',
      status: 'perm' as const,
    };
    expect(formatTuiTerminalTitle(input)).toBe('Needs approval | 修复 登录 | MCode');
    expect(
      formatTuiTerminalTitle(input, ['session-name', 'status', 'status', 'unknown', 'toString']),
    ).toBe('修复 登录 | Needs approval');
    expect(formatTuiTerminalTitle(input, null)).toBeUndefined();
    expect(formatTuiTerminalTitle(input, [])).toBeUndefined();
    expect(formatTuiTerminalTitle({ ...input, title: 'New session' })).toBe(
      'Needs approval | workspace (session-) | MCode',
    );
    const long = formatTuiTerminalTitle({ ...input, title: '😀'.repeat(300) })!;
    expect(Array.from(long)).toHaveLength(240);
    expect(long).not.toContain('\ufffd');
  });

  it('deduplicates writes, releases its title on suspend and reapplies it on resume', () => {
    const terminal = { setTitle: vi.fn() };
    const title = new TuiTerminalTitle(terminal, true);
    title.update('Before start');
    expect(terminal.setTitle).not.toHaveBeenCalled();
    title.setActive(true);
    title.update('Working | session');
    title.update('Working | session');
    expect(terminal.setTitle).toHaveBeenCalledTimes(1);
    title.setActive(false);
    title.update('Late update');
    expect(terminal.setTitle).toHaveBeenLastCalledWith('');
    title.setActive(true);
    title.update('Working | session');
    title.dispose();
    title.setActive(true);
    title.update('After dispose');
    expect(terminal.setTitle.mock.calls.flat()).toEqual([
      'Working | session',
      '',
      'Working | session',
      '',
    ]);
  });

  it('does not clear an unmanaged title or write to a non-TTY', () => {
    const terminal = { setTitle: vi.fn() };
    const disabled = new TuiTerminalTitle(terminal, true);
    disabled.setActive(true);
    disabled.update(undefined);
    disabled.dispose();
    const redirected = new TuiTerminalTitle(terminal, false);
    redirected.setActive(true);
    redirected.update('Redirected');
    redirected.dispose();
    expect(terminal.setTitle).not.toHaveBeenCalled();
  });

  it('does not cache a failed title write or interrupt the caller', () => {
    const terminal = {
      setTitle: vi.fn().mockImplementationOnce(() => {
        throw new Error('closed');
      }),
    };
    const title = new TuiTerminalTitle(terminal, true);
    title.setActive(true);
    expect(() => title.update('Ready')).not.toThrow();
    title.update('Ready');
    title.update('Ready');
    expect(terminal.setTitle).toHaveBeenCalledTimes(2);
  });
});

describe('OSC 7501 program status', () => {
  it.each([
    ['ready', 'state=idle'],
    ['run', 'state=working'],
    ['perm', 'state=blocked:kind=permission'],
    ['plan', 'state=blocked:kind=permission'],
    ['ask', 'state=blocked:kind=question'],
    ['auth', 'state=blocked:kind=auth'],
    ['done', 'state=done'],
    ['fail', 'state=error'],
    ['error', 'state=error'],
    ['cancel', 'state=idle'],
  ] as const)('reports %s using fixed protocol metadata', (state, body) => {
    const terminal = { write: vi.fn() };
    const status = new TuiTerminalProgramStatus(terminal, true);
    status.setActive(true);
    status.update(state);
    status.update(state);
    expect(terminal.write.mock.calls).toEqual([[`\u001b]7501;${body}:app=mcode\u001b\\`]]);
  });

  it('releases a suspended TUI, ignores late updates and reapplies status on resume', () => {
    const terminal = { write: vi.fn() };
    const status = new TuiTerminalProgramStatus(terminal, true);
    status.update('run');
    expect(terminal.write).not.toHaveBeenCalled();
    status.setActive(true);
    status.update('perm');
    status.update('plan');
    status.setActive(false);
    status.update('ask');
    status.setActive(true);
    status.update('ask');
    status.dispose();
    status.setActive(true);
    status.update('run');
    expect(terminal.write.mock.calls.flat()).toEqual([
      '\u001b]7501;state=blocked:kind=permission:app=mcode\u001b\\',
      '\u001b]7501;state=idle:app=mcode\u001b\\',
      '\u001b]7501;state=blocked:kind=question:app=mcode\u001b\\',
      '\u001b]7501;state=idle:app=mcode\u001b\\',
    ]);
  });

  it.each(['done', 'fail', 'error'] as const)('preserves %s on exit', (state) => {
    const terminal = { write: vi.fn() };
    const status = new TuiTerminalProgramStatus(terminal, true);
    status.setActive(true);
    status.update(state);
    status.dispose();
    status.dispose();
    status.update('ready');
    expect(terminal.write).toHaveBeenCalledTimes(1);
  });

  it('never writes to a non-TTY or clears a record it did not write', () => {
    const terminal = { write: vi.fn() };
    for (const isTTY of [false, true]) {
      const status = new TuiTerminalProgramStatus(terminal, isTTY);
      status.setActive(true);
      if (!isTTY) status.update('run');
      status.setActive(false);
      status.dispose();
    }
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('ignores unknown states and retries failed writes without interrupting the caller', () => {
    const terminal = {
      write: vi.fn().mockImplementationOnce(() => {
        throw new Error('closed');
      }),
    };
    const status = new TuiTerminalProgramStatus(terminal, true);
    status.setActive(true);
    status.update('unknown' as TuiProgramStatus);
    expect(() => status.update('run')).not.toThrow();
    status.update('run');
    status.update('run');
    expect(terminal.write).toHaveBeenCalledTimes(2);
  });
});

describe('terminal notification policy and transport', () => {
  it('preserves live focus through the production wrapper and suppresses each foreground event once', () => {
    const base = { focused: true, write: vi.fn() };
    const terminal = createObservedTerminal(base as unknown as Terminal, vi.fn());
    const notifications = new TuiTerminalNotifications(terminal, {
      capabilities: capabilities(),
    });
    notifications.setActive(true);
    expect(notifications.notifyOnce('turn-complete', 'turn-1')).toBe(false);
    base.focused = false;
    expect(terminal.focused).toBe(false);
    expect(notifications.notifyOnce('turn-complete', 'turn-1')).toBe(false);
    expect(notifications.notifyOnce('permission-required', 'permission-1')).toBe(true);
    expect(base.write.mock.calls).toEqual([['\u0007']]);
  });

  it('honors event filters, always/never, unknown focus and non-TTY output', () => {
    const terminal = { focused: true, write: vi.fn() };
    const filtered = new TuiTerminalNotifications(terminal, {
      capabilities: capabilities(),
      settings: { when: 'always', events: ['turn-failed'] },
    });
    filtered.setActive(true);
    expect(filtered.notifyOnce('turn-complete', 'done')).toBe(false);
    expect(filtered.notifyOnce('turn-failed', 'failed')).toBe(true);
    for (const options of [
      { capabilities: capabilities(), settings: { when: 'never' as const } },
      { capabilities: capabilities({}, 'linux', false) },
      { capabilities: capabilities(), settings: { events: [] } },
    ]) {
      const notifications = new TuiTerminalNotifications({ write: terminal.write }, options);
      notifications.setActive(true);
      expect(notifications.notifyOnce('turn-complete', 'done')).toBe(false);
    }
    const unknown = new TuiTerminalNotifications(
      { write: terminal.write },
      { capabilities: capabilities() },
    );
    unknown.setActive(true);
    expect(unknown.notifyOnce('turn-complete', 'done')).toBe(true);
    expect(terminal.write).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ TERM_PROGRAM: 'vscode' }, '\u0007'],
    [{ TERM_PROGRAM: 'ITERM.APP' }, '\u001b]9;'],
    [{ TERM: 'xterm-ghostty' }, '\u001b]9;'],
    [{ TERM: 'xterm-kitty' }, '\u001b]99;'],
    [{ TERM_PROGRAM: 'cmux' }, '\u001b]777;'],
    [{ TERM_PROGRAM: 'WarpTerminal' }, '\u001b]9;'],
    [{ TMUX: 'synthetic', TERM_PROGRAM: 'iTerm.app' }, '\u001bPtmux;'],
  ])('uses the shared terminal detection for %j', (env, prefix) => {
    const sequences = buildTuiTerminalNotificationSequences(
      { title: 'MCode', body: 'Complete' },
      env,
    );
    expect(sequences[0]?.startsWith(prefix)).toBe(true);
  });

  it('assigns distinct kitty IDs and sanitizes title/body before framing', () => {
    const env = { TERM: 'xterm-kitty' };
    const message = {
      title: 'MCode\u001b]0;injected\u0007',
      body: '修复\n登录\u0007',
    };
    const first = buildTuiTerminalNotificationSequences(message, env);
    const second = buildTuiTerminalNotificationSequences(message, env);
    const id = first[0]!.match(/i=([^:;]+)/u)![1];
    expect(first[1]).toContain(`i=${id}:p=body:d=1;修复 登录`);
    expect(first.join('')).not.toContain('injected');
    expect(first[0]).not.toBe(second[0]);
    const cmux = buildTuiTerminalNotificationSequences(
      { title: 'a;b', body: 'c;d' },
      { TERM_PROGRAM: 'cmux' },
    );
    expect(cmux).toEqual(['\u001b]777;notify;a,b;c,d\u0007']);
  });

  it('does not execute a Windows bridge on SSH or ordinary Linux', () => {
    for (const env of [
      { WT_SESSION: 'test', SSH_CONNECTION: 'synthetic' },
      { WT_SESSION: 'test' },
    ]) {
      const executeFile = vi.fn();
      const terminal = { write: vi.fn() };
      const notifications = new TuiTerminalNotifications(terminal, {
        environment: env,
        capabilities: capabilities(env),
        executeFile,
      });
      notifications.setActive(true);
      expect(notifications.notifyOnce('turn-complete', 'done')).toBe(true);
      expect(executeFile).not.toHaveBeenCalled();
      expect(terminal.write).toHaveBeenCalledWith('\u0007');
    }
  });

  it('quotes native notification text and ignores native failures from a suspended generation', () => {
    const env = { WT_SESSION: 'test' };
    const terminal = { write: vi.fn() };
    let callback: ((error: Error | null) => void) | undefined;
    const executeFile = vi.fn(
      (_file: string, _args: readonly string[], done: (error: Error | null) => void) => {
        callback = done;
      },
    );
    const notifications = new TuiTerminalNotifications(terminal, {
      environment: env,
      capabilities: capabilities(env, 'win32'),
      executeFile,
    });
    notifications.setActive(true);
    notifications.notifyOnce('turn-complete', 'done', "User's session");
    expect(executeFile.mock.calls[0]?.[1][2]).toContain("User''s session: Response complete");
    notifications.setActive(false);
    notifications.setActive(true);
    callback?.(new Error('timeout'));
    expect(terminal.write).not.toHaveBeenCalled();
    notifications.dispose();
    expect(notifications.notifyOnce('turn-failed', 'late')).toBe(false);
    expect(executeFile).toHaveBeenCalledTimes(1);
  });
});
