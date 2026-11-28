import { posix, win32 } from 'node:path';

import { inferTuiAudioPdfMimeType } from '../../../application/audio-pdf-mime.js';

const TERMINAL_IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);

export function isTuiTerminalImagePaste(value: string): boolean {
  const trimmed = stripMatchingQuotes(value.trim());
  if (!trimmed || /[\r\n]/u.test(trimmed)) return false;
  const normalized = trimmed.replaceAll('\\', '/');
  if (
    !normalized.includes('/otty-paste/') &&
    !posix.isAbsolute(normalized) &&
    !win32.isAbsolute(trimmed)
  ) {
    return false;
  }
  const extension = posix.extname(normalized).toLocaleLowerCase();
  return (
    TERMINAL_IMAGE_EXTENSIONS.has(extension) || inferTuiAudioPdfMimeType(normalized) !== undefined
  );
}

export function getTuiTerminalImagePasteFallbackPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const trimmed = value.trim();
  if (
    platform === 'win32' ||
    !isTuiTerminalImagePaste(trimmed) ||
    !posix.isAbsolute(trimmed) ||
    win32.parse(trimmed).root !== posix.parse(trimmed).root
  ) {
    return undefined;
  }
  const unescaped = trimmed.replace(/\\([\\ ])/gu, '$1');
  return unescaped === trimmed ? undefined : unescaped;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}
