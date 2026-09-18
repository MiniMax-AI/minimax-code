import { McodeProviderApplication } from '../provider/application.js';
import type { McodeProviderApiFormat, McodeProviderSnapshot } from '../provider/contract.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import { createTuiRuntime, shutdownTuiRuntime } from '../runtime/lifecycle.js';
import { formatTuiActionFailure } from '../user-facing-failure.js';

export type McodeProviderCliRequest =
  | { readonly action: 'list'; readonly json?: boolean }
  | {
      readonly action: 'add';
      readonly name: string;
      readonly baseUrl: string;
      readonly apiFormat: McodeProviderApiFormat;
      readonly models: readonly string[];
      readonly contextLimit?: number;
      readonly outputLimit?: number;
      readonly apiKeyEnv?: string;
      readonly saveAndUse?: boolean;
    }
  | { readonly action: 'remove'; readonly providerId: string; readonly confirmed: boolean }
  | {
      readonly action: 'test';
      readonly providerId: string;
      readonly modelId?: string;
      readonly json?: boolean;
    }
  | { readonly action: 'set-minimax-key'; readonly apiKeyEnv?: string }
  | { readonly action: 'use'; readonly source: 'token_plan' | 'minimax_api_key' };

interface McodeProviderCommandContext {
  readonly application: McodeProviderApplication;
  shutdown(): Promise<void>;
}

export interface RunMcodeProviderCommandOptions {
  readonly version: string;
  readonly request: McodeProviderCliRequest;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workspaceDir?: string;
  readonly lane?: string;
  readonly createContext?: (lane?: string) => Promise<McodeProviderCommandContext>;
}

export async function runMcodeProviderCommand(
  options: RunMcodeProviderCommandOptions,
): Promise<string> {
  const context = options.createContext
    ? await options.createContext(options.lane)
    : await createProviderCommandContext(options.version, options.workspaceDir, options.lane);
  try {
    const { request } = options;
    if (request.action === 'list') {
      return formatSnapshot(await context.application.snapshot(), Boolean(request.json));
    }
    if (request.action === 'add') {
      const envName = request.apiKeyEnv?.trim() || 'MCODE_PROVIDER_API_KEY';
      const apiKey = (options.environment ?? process.env)[envName]?.trim();
      if (!apiKey) {
        throw new Error(
          `Provider API key is missing. Set ${envName} or pass --api-key-env <name>.`,
        );
      }
      const input = {
        name: request.name,
        baseUrl: request.baseUrl,
        apiKey,
        apiFormat: request.apiFormat,
        models: request.models.map((modelId) => ({
          modelId,
          ...(request.contextLimit !== undefined || request.outputLimit !== undefined
            ? {
                limit: {
                  ...(request.contextLimit !== undefined ? { context: request.contextLimit } : {}),
                  ...(request.outputLimit !== undefined ? { output: request.outputLimit } : {}),
                },
              }
            : {}),
        })),
      };
      if (request.saveAndUse) {
        const modelId = request.models[0];
        if (!modelId) throw new Error('At least one --model <id> is required.');
        const result = await context.application.saveCandidate({
          ...input,
          modelId,
          saveAndUse: true,
        });
        if (!result.success) {
          throw new Error(
            formatTuiActionFailure(
              result.status?.lastErrorMessage ?? result.status?.state ?? 'Connection unavailable',
              {
                summary: 'Provider connection test failed. Nothing was saved or selected.',
                nextStep:
                  'Check the URL, API key, and first model ID, then retry; omit --use to save without testing.',
              },
            ),
          );
        }
        return `Provider added and selected: ${request.name}`;
      }
      await context.application.create(input);
      return `Provider added: ${request.name}`;
    }
    if (request.action === 'remove') {
      if (!request.confirmed) {
        throw new Error('Refusing to remove a provider without --yes.');
      }
      await context.application.remove(request.providerId);
      return `Provider removed: ${request.providerId}`;
    }
    if (request.action === 'test') {
      if (request.providerId === 'minimax_oauth') {
        const message = 'MiniMax OAuth sign-in and connectivity are managed by /login.';
        if (request.json) {
          return JSON.stringify(
            {
              success: false,
              status: { state: 'unsupported', lastErrorMessage: message },
            },
            null,
            2,
          );
        }
        return formatTuiActionFailure(message, {
          summary: 'MiniMax OAuth provider test skipped.',
          nextStep: 'Run /login to manage Token Plan sign-in.',
        });
      }
      const result = await context.application.test(request.providerId, request.modelId);
      if (request.json) return JSON.stringify(result, null, 2);
      return result.success
        ? `Provider available: ${request.providerId}${request.modelId ? `/${request.modelId}` : ''}`
        : formatTuiActionFailure(result.status.lastErrorMessage ?? result.status.state, {
            summary: 'Provider test failed.',
            nextStep: 'Check the URL, API key, and model ID, then retry.',
          });
    }
    if (request.action === 'set-minimax-key') {
      const envName = request.apiKeyEnv?.trim() || 'MCODE_PROVIDER_API_KEY';
      const apiKey = (options.environment ?? process.env)[envName]?.trim();
      if (!apiKey) {
        throw new Error(`MiniMax API key is missing. Set ${envName} or pass --api-key-env <name>.`);
      }
      await context.application.setMiniMaxApiKey(apiKey);
      return 'MiniMax API Key saved and selected.';
    }
    await context.application.setMiniMaxSource(request.source);
    return request.source === 'token_plan' ? 'Using MiniMax Token Plan.' : 'Using MiniMax API Key.';
  } finally {
    await context.shutdown();
  }
}

async function createProviderCommandContext(
  version: string,
  workspaceDir = process.cwd(),
  lane?: string,
): Promise<McodeProviderCommandContext> {
  const runtime = await createTuiRuntime({
    dataDir: await prepareTuiDataDir(),
    workspaceDir,
    version,
    surface: 'headless',
    ...(lane ? { lane } : {}),
  });
  return {
    application: new McodeProviderApplication(runtime.adapter),
    shutdown: async () => {
      await shutdownTuiRuntime(runtime);
    },
  };
}

function formatSnapshot(snapshot: McodeProviderSnapshot, json: boolean): string {
  if (json) return JSON.stringify(snapshot, null, 2);
  const lines = snapshot.providers.map((provider) => {
    const state = provider.active ? 'active' : provider.enabled ? 'enabled' : 'disabled';
    const credential =
      provider.kind === 'minimax-oauth'
        ? 'managed login'
        : provider.hasApiKey
          ? (provider.maskedApiKey ?? 'key saved')
          : 'no key';
    return `${provider.active ? '*' : ' '} ${provider.providerId}\t${state}\t${credential}`;
  });
  return lines.join('\n');
}
