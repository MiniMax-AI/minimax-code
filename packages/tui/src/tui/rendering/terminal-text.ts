import { stripVTControlCharacters } from 'node:util';

/** A bounded, single-line label suitable for an OSC payload. */
export function sanitizeTerminalLabel(value: string, maxLength = 240): string {
  return Array.from(
    sanitizeTerminalText(value)
      .replace(/[\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
    .slice(0, maxLength)
    .join('');
}

export function sanitizeTerminalText(value: string): string {
  // Consume terminal strings, including incomplete streaming prefixes and C1
  // forms, before stripping ordinary ANSI styles. Their payload is not prose.
  const text = value.replace(
    /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu,
    '',
  );
  return stripVTControlCharacters(text)
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}
