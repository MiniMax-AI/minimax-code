import type { LocalCustomProviderConfig, LocalModelConfig } from '../contracts.js';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
// Codex model discovery negotiates against the Codex client version, independent of our app version.
const CODEX_CATALOG_CLIENT_VERSION = '0.162.0';

export interface CodexModelCredentials {
  access: string;
  accountId: string;
}

export class CodexModelDiscoveryClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async discover(credentials: CodexModelCredentials): Promise<LocalCustomProviderConfig> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${CODEX_BASE_URL}/codex/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${credentials.access}`,
            'ChatGPT-Account-ID': credentials.accountId,
            originator: 'pi',
            Accept: 'application/json',
          },
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Codex model discovery failed (HTTP ${response.status}).`);
      }
      return parseCatalog(await response.json());
    } catch (error) {
      // Never forward response bodies or transport errors that may include credentials.
      if (
        error instanceof Error &&
        /^Codex model discovery failed \(HTTP \d+\)\.$/.test(error.message)
      ) {
        throw error;
      }
      throw new Error('Codex model discovery failed. Retry connecting or reopen model settings.');
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseCatalog(payload: unknown): LocalCustomProviderConfig {
  const records = readRecord(payload)?.models;
  if (!Array.isArray(records)) throw new Error('Invalid Codex model catalog.');
  const entries = records.flatMap((item): [string, LocalModelConfig][] => {
    const model = readRecord(item);
    if (!model || model.visibility !== 'list') return [];
    const id = readString(model.slug);
    if (!id) return [];
    return [[id, parseModel(model, id)]];
  });
  if (entries.length === 0) throw new Error('Empty Codex model catalog.');
  return {
    api: 'openai-codex-responses',
    name: 'OpenAI Codex',
    kind: 'oauth',
    enabled: true,
    options: { authMode: 'oauth', baseURL: CODEX_BASE_URL },
    models: Object.fromEntries(entries),
  };
}

function parseModel(model: Record<string, unknown>, id: string): LocalModelConfig {
  const effortOptions = readEfforts(model.supported_reasoning_levels);
  const input = readInputModalities(model.input_modalities);
  const context =
    readPositiveInteger(model.context_window) ?? readPositiveInteger(model.max_context_window);
  return {
    name: readString(model.display_name) ?? id,
    reasoning: effortOptions.length > 0,
    attachment: input.includes('image'),
    tool_call: true,
    modalities: { input, output: ['text'] },
    ...(context ? { limit: { context } } : {}),
    thinking: { effortOptions },
  };
}

function readEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((entry) => {
        const effort = readString(readRecord(entry)?.effort);
        return effort ? [effort] : [];
      }),
    ),
  ];
}

function readInputModalities(value: unknown): ('text' | 'image')[] {
  if (!Array.isArray(value)) return ['text', 'image'];
  return value.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image');
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
