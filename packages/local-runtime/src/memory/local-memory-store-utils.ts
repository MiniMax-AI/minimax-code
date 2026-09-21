import { createHash } from 'node:crypto';
import { readdir, readFile, unlink } from 'node:fs/promises';

import { LocalMemoryError, type LocalMemorySearchResult } from './types.js';

export function appendWithSeparator(current: string, addition: string): string {
  if (!current.trim()) return addition;
  return `${current.replace(/\s*$/, '')}\n${addition}`;
}

export function applyEdit(
  current: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { content: string; replacements: number } {
  if (!oldString) throw new LocalMemoryError('OLD_STRING_EMPTY', 'old_string is required');
  const matches = current.split(oldString).length - 1;
  if (matches === 0) throw new LocalMemoryError('OLD_STRING_NOT_FOUND', 'old_string not found');
  if (!replaceAll && matches > 1) {
    throw new LocalMemoryError('OLD_STRING_AMBIGUOUS', 'old_string is ambiguous');
  }
  // split/join inserts newString literally; String.prototype.replace would expand
  // $&, $$, $`, $' and silently rewrite the replacement text. The replaceAll=false
  // path is already guarded to a single match above.
  const content = current.split(oldString).join(newString);
  return { content, replacements: replaceAll ? matches : 1 };
}

export function searchLines(content: string, query: string): LocalMemorySearchResult[] {
  const lower = query.toLowerCase();
  if (!lower) return [];
  const lines = content.split(/\r?\n/);
  return lines.flatMap((line, index) =>
    line.toLowerCase().includes(lower)
      ? [{ lineNumber: index + 1, line, context: lines.slice(Math.max(0, index - 1), index + 2) }]
      : [],
  );
}

const TOPIC_HEADER_RE = /^---\ndescription: ([\s\S]*?)\n---\n\n/;

export function parseTopic(content: string): { description: string; body: string } {
  const match = TOPIC_HEADER_RE.exec(content);
  if (!match) return { description: '', body: content };
  return { description: decodeURIComponent(match[1] ?? ''), body: content.slice(match[0].length) };
}

export function formatTopic(description: string, content: string): string {
  return `---\ndescription: ${encodeURIComponent(description)}\n---\n\n${content}`;
}

export function formatLocalDate(input: number | Date = Date.now()): string {
  const date = input instanceof Date ? input : new Date(input);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatLocalDateTime(input: number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${formatLocalDate(date)} ${hours}:${minutes}:${seconds}`;
}

export function assertSafeAgentName(agentName: string | undefined): string {
  const normalized = agentName?.trim();
  if (!normalized) throw new LocalMemoryError('AGENT_NAME_REQUIRED', 'agent_name is required');
  // Path-safety: the agent name becomes a path segment under agents/<name>/, so
  // reject anything that could escape that directory or break the path.
  if (
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('..') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(normalized)
  ) {
    throw new LocalMemoryError('INVALID_AGENT_NAME', `invalid agent_name: ${agentName}`);
  }
  return normalized;
}

export function assertDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new LocalMemoryError('INVALID_DATE', 'invalid date');
  return date;
}

export function today(): string {
  return formatLocalDate();
}

export function formatTs(ts: number): string {
  return formatLocalDateTime(ts);
}

export function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

export function firstLine(content: string): string | undefined {
  return content
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.slice(0, 200);
}

export async function safeRead(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
}

export async function safeReaddir(dir: string): Promise<string[]> {
  return readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
}

export async function deleteIfExists(filePath: string): Promise<boolean> {
  return unlink(filePath)
    .then(() => true)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    });
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
