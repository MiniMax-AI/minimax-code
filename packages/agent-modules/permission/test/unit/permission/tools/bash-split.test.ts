import { describe, expect, it } from 'vitest';

import { splitCommand, splitShellSourceSegments } from '../../../../src/tools/bash-split.js';

describe('shell source segments', () => {
  it('retains executable substitutions in loop headers and assignments for safety checks', () => {
    expect(
      splitShellSourceSegments('for x in $( rm -rf "$HOME" ); do :; done; value=$( rm -rf / )'),
    ).toEqual(['for x in $( rm -rf "$HOME" )', 'do :', 'done', 'value=$( rm -rf / )']);
  });
});

describe('background command boundaries', () => {
  it('splits commands without surrounding whitespace', () => {
    expect(splitCommand('rm -- ./old&rm -rf "$HOME"')).toEqual([
      'rm -- ./old',
      'rm -rf "$HOME"',
    ]);
  });

  it.each([
    'echo "a&b"',
    "echo 'a&b'",
    String.raw`echo a\&b`,
    'echo ok 2>&1',
    'cat <&0',
    'echo ok &>log',
    'echo ok &>>log',
  ])('preserves literal or redirection ampersands: %s', (command) => {
    expect(splitCommand(`${command}&echo done`)).toEqual([command, 'echo done']);
  });
});
