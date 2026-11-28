import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import { createTuiAcpAgent } from './agent.js';
import type { TuiAcpRuntime } from './runtime.js';
import type { MavisRegion } from '@mavis/config';

export interface ServeTuiAcpStdioOptions {
  readonly runtime: TuiAcpRuntime;
  readonly version: string;
  readonly input: Readable;
  readonly output: Writable;
  readonly signal?: AbortSignal;
  readonly switchRegion?: (region: MavisRegion) => Promise<TuiAcpRuntime>;
  readonly rememberRegion?: (region: MavisRegion) => void;
  readonly authApiKey?: string;
}

export async function serveTuiAcpStdio(options: ServeTuiAcpStdioOptions): Promise<void> {
  const stream = acp.ndJsonStream(Writable.toWeb(options.output), Readable.toWeb(options.input));
  const connection = createTuiAcpAgent({
    runtime: options.runtime,
    version: options.version,
    ...(options.switchRegion ? { switchRegion: options.switchRegion } : {}),
    ...(options.rememberRegion ? { rememberRegion: options.rememberRegion } : {}),
    ...(options.authApiKey ? { authApiKey: options.authApiKey } : {}),
  }).connect(stream);
  const close = () => connection.close(options.signal?.reason);
  options.signal?.addEventListener('abort', close, { once: true });
  if (options.signal?.aborted) close();
  try {
    await connection.closed;
  } finally {
    options.signal?.removeEventListener('abort', close);
  }
}
