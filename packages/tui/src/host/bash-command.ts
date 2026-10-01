import { StringDecoder } from 'node:string_decoder';
import { stripRuntimeBoundaryKeysFrom } from '@mavis/shared/runtime-boundary-env';

export interface TuiBashResult {
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
}

export type ExecuteTuiBash = (input: {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly onOutput: (text: string) => void;
}) => Promise<TuiBashResult>;

export const executeTuiBash: ExecuteTuiBash = async (input) => {
  const { createLocalBashOperations } = await import('@earendil-works/pi-coding-agent/tools');
  const operations = createLocalBashOperations({ parentDeathGuard: true });
  const env = { ...process.env };
  stripRuntimeBoundaryKeysFrom(env, 'agent-runtime');
  const decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
    combined: new StringDecoder('utf8'),
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
