import { resolve } from 'node:path';

import { validateThreadOptions } from './args.js';
import { resolveCli, type ResolvedCli } from './cli-resolver.js';
import { MCodeInvocationError } from './errors.js';
import { Thread, type ThreadHost } from './thread.js';
import type { MCodeOptions, ThreadOptions } from './types.js';
import { checkCliVersion } from './version.js';

/** Entry point of the SDK. One instance resolves and version-checks the CLI once. */
export class MCode {
  private cli: Promise<ResolvedCli> | undefined;
  private readonly host: ThreadHost;

  constructor(private readonly options: MCodeOptions = {}) {
    this.host = {
      ...(options.configPath === undefined ? {} : { configPath: resolve(options.configPath) }),
      childEnv: () => this.childEnv(),
      prepareCli: () => this.prepareCli(),
    };
  }

  /** Starts a new Thread. The Session is created by its first Turn. */
  startThread(options: ThreadOptions = {}): Thread {
    validateThreadOptions(options, false);
    return new Thread(this.host, options, null);
  }

  /** Continues an existing Session, for example one persisted from `thread.id`. */
  resumeThread(id: string, options: ThreadOptions = {}): Thread {
    if (typeof id !== 'string' || !id.trim()) {
      throw new MCodeInvocationError('resumeThread requires a non-empty Session id.');
    }
    validateThreadOptions(options, true);
    return new Thread(this.host, options, id.trim());
  }

  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...(this.options.env ?? process.env) };
    if (this.options.dataDir !== undefined) env.MINIMAX_DATA_DIR = resolve(this.options.dataDir);
    return env;
  }

  private prepareCli(): Promise<ResolvedCli> {
    this.cli ??= (async () => {
      const env = this.childEnv();
      const cli = resolveCli({
        ...(this.options.bin === undefined ? {} : { bin: this.options.bin }),
        env,
      });
      await checkCliVersion(cli, env);
      return cli;
    })().catch((error: unknown) => {
      // Allow a later run to succeed after the user installs or upgrades the CLI.
      this.cli = undefined;
      throw error;
    });
    return this.cli;
  }
}
