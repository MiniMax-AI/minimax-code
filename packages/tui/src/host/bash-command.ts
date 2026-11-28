import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripRuntimeBoundaryKeysFrom } from '@mavis/shared/runtime-boundary-env';

export interface TuiBashResult {
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
}

export type ExecuteTuiBash = (input: {
  readonly command: string;
  readonly dataDir?: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly onOutput: (text: string) => void;
}) => Promise<TuiBashResult>;

export const executeTuiBash: ExecuteTuiBash = async (input) => {
  const { createLocalBashOperations, createShellOutputDecoder } =
    await import('@earendil-works/pi-coding-agent/tools');
  const configPath = input.dataDir ? join(input.dataDir, 'config.yaml') : undefined;
  const skipParentDeathGuard =
    input.dataDir && configPath && existsSync(configPath)
      ? await readSkipParentDeathGuard(configPath, input.dataDir)
      : false;
  const operations = createLocalBashOperations({ parentDeathGuard: !skipParentDeathGuard });
  const env = { ...process.env };
  stripRuntimeBoundaryKeysFrom(env, 'agent-runtime');
  const decoders = {
    stdout: createShellOutputDecoder(),
    stderr: createShellOutputDecoder(),
    combined: createShellOutputDecoder(),
  };
  try {
    const result = await operations.exec(input.command, input.cwd, {
      signal: input.signal,
      env,
      onData: (data, stream) => input.onOutput(decoders[stream ?? 'combined'].write(data)),
    });
    return { exitCode: result.exitCode ?? undefined, cancelled: input.signal.aborted };
  } catch (error) {
    if (input.signal.aborted) return { exitCode: undefined, cancelled: true };
    throw error;
  } finally {
    for (const decoder of Object.values(decoders)) input.onOutput(decoder.end());
  }
};

/**
 * A broken profile config must not stop `!` commands: keep the guardian on
 * (the default) and leave the problem to the startup notice.
 */
async function readSkipParentDeathGuard(configPath: string, dataDir: string): Promise<boolean> {
  try {
    const { loadConfigFromFile } = await import('@mavis/config');
    return loadConfigFromFile(configPath, { dataDir }).skipParentDeathGuard;
  } catch {
    return false;
  }
}
