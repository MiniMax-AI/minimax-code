import { createHash } from 'node:crypto';

const UTF8_CHUNK_CODE_UNITS = 8 * 1_024;

/** Native SHA-256 with bounded UTF-8 chunks and the existing update boundaries. */
export class IncrementalSha256 {
  private readonly hash = createHash('sha256');
  private finalized = false;

  update(value: string): void {
    if (this.finalized) throw new Error('SHA-256 digest is already finalized.');
    let offset = 0;
    while (offset < value.length) {
      const end = safeUtf8ChunkEnd(value, offset);
      this.hash.update(value.slice(offset, end), 'utf8');
      offset = end;
    }
  }

  digestHex(): string {
    if (this.finalized) throw new Error('SHA-256 digest is already finalized.');
    this.finalized = true;
    return this.hash.digest('hex');
  }
}

function safeUtf8ChunkEnd(value: string, offset: number): number {
  let end = Math.min(value.length, offset + UTF8_CHUNK_CODE_UNITS);
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (end < value.length && isHighSurrogate(last) && isLowSurrogate(next)) end -= 1;
  return end;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
