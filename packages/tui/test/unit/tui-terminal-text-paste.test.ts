import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessTerminal, StdinBuffer } from '../../src/tui/engine/public.js';
import { Editor } from '../../src/tui/widgets/editor/editor.js';

const startPaste = '\x1b[200~';
const endPaste = '\x1b[201~';
const identity = (text: string) => text;

function createHarness() {
  const stdin = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode: vi.fn(),
  });
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as typeof process.stdin);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.stubEnv('TERM_PROGRAM', '');
  const editor = new Editor(
    { terminal: { rows: 24 }, requestRender: vi.fn() },
    {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity, selectedText: identity, description: identity,
        scrollInfo: identity, noMatch: identity,
      },
    },
  );
  const submitted = vi.fn();
  editor.onSubmit = submitted;
  const terminal = new ProcessTerminal();
  const input = vi.fn((data: string) => editor.handleInput(data));
  const start = () => terminal.start(input, () => {});
  start();
  return { editor, submitted, terminal, input, output, stdin, start,
    send: (data: string) => stdin.emit('data', data) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('terminal text paste', () => {
  it.each(['\r', '\n', '\r\n'])('preserves unframed multiline chunks with %j line endings', (eol) => {
    const h = createHarness();
    try {
      h.send(`first${eol}第二行 😀${eol}last${eol}`);
      expect(h.submitted).not.toHaveBeenCalled();
      expect(h.editor.getExpandedText()).toBe('first\n第二行 😀\nlast\n');
      h.send('\r');
      expect(h.submitted.mock.calls.map(([text]) => text)).toEqual(['first\n第二行 😀\nlast']);
    } finally { h.terminal.stop(); }
  });

  it('retains immediate Enter and shortcut dispatch for ordinary key input', () => {
    const h = createHarness();
    try {
      for (const character of 'typed quickly') h.send(character);
      h.send('\r');
      h.send('batched text\r');
      expect(h.submitted.mock.calls.map(([text]) => text)).toEqual(['typed quickly', 'batched text']);
      h.send('\x1b[A\x03\x1b[13;2u');
      expect(h.input.mock.calls.slice(-3)).toEqual([['\x1b[A'], ['\x03'], ['\x1b[13;2u']]);
    } finally { h.terminal.stop(); }
  });

  it('uses the paste path for a large payload with tabs and Unicode', () => {
    const h = createHarness();
    const payload = Array.from({ length: 20 }, (_, i) => `line ${i}\t中文 😀`).join('\r\n');
    try {
      h.send(payload);
      expect(h.submitted).not.toHaveBeenCalled();
      expect(h.editor.getText()).toMatch(/^\[paste #1 /);
      expect(h.editor.getExpandedText()).toBe(payload.replace(/\r\n/g, '\n').replace(/\t/g, '    '));
    } finally { h.terminal.stop(); }
  });

  it('reassembles bracketed paste at every chunk boundary before accepting Enter', () => {
    const h = createHarness();
    const payload = 'first\r\n第二行\rlast\n';
    const wire = `${startPaste}${payload}${endPaste}`;
    try {
      for (let split = 1; split < wire.length; split++) {
        h.editor.setText('');
        h.submitted.mockClear();
        h.send(wire.slice(0, split));
        h.send(wire.slice(split));
        expect(h.submitted).not.toHaveBeenCalled();
        expect(h.editor.getExpandedText()).toBe('first\n第二行\nlast\n');
        h.send('\r');
        expect(h.submitted.mock.calls.map(([text]) => text)).toEqual(['first\n第二行\nlast']);
      }
    } finally { h.terminal.stop(); }
  });

  it('enables paste mode after restart and discards an unfinished previous paste', () => {
    const h = createHarness();
    try {
      expect(h.output).toHaveBeenCalledWith('\x1b[?2004h');
      h.send(`${startPaste}unfinished\r`);
      h.terminal.stop();
      expect(h.output).toHaveBeenCalledWith('\x1b[?2004l');
      expect(h.stdin.listenerCount('data')).toBe(0);
      h.output.mockClear();
      h.start();
      expect(h.output).toHaveBeenCalledWith('\x1b[?2004h');
      h.send(`${startPaste}new\r\ntext${endPaste}\r`);
      expect(h.submitted.mock.calls.map(([text]) => text)).toEqual(['new\ntext']);
    } finally { h.terminal.stop(); }
  });

  it('keeps control sequences and incomplete escape sequences out of the unframed fallback', () => {
    const buffer = new StdinBuffer();
    const paste = vi.fn();
    const data = vi.fn();
    buffer.on('paste', paste);
    buffer.on('data', data);
    try {
      buffer.process('first\r\x03last');
      expect(paste).not.toHaveBeenCalled();
      expect(data.mock.calls).toContainEqual(['\x03']);
      buffer.process('\x1b[');
      buffer.process('first\rlast');
      expect(paste).not.toHaveBeenCalled();
    } finally { buffer.destroy(); }
  });

  it('does not time out a bracketed payload or merge neighboring keyboard events into it', () => {
    vi.useFakeTimers();
    const buffer = new StdinBuffer();
    const events: string[][] = [];
    buffer.on('paste', (text) => events.push(['paste', text]));
    buffer.on('data', (text) => events.push(['data', text]));
    try {
      buffer.process(`a${startPaste}first\r`);
      vi.advanceTimersByTime(1_000);
      buffer.process(`\nsecond${endPaste}${startPaste}${endPaste}\r`);
      expect(events).toEqual([
        ['data', 'a'], ['paste', 'first\r\nsecond'], ['paste', ''], ['data', '\r'],
      ]);
    } finally {
      buffer.destroy();
      vi.useRealTimers();
    }
  });
});
