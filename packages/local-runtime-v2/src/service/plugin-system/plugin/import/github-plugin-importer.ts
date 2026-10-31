import { readImportedPluginPackage } from '../package/package-readers.js';
import { PluginPackageContractError } from '../package/package-contract.js';
import { PluginReaderError } from '../package/reader-errors.js';
import { PluginSystemError } from '../../errors.js';
import type { ReadPluginPackage } from '../package/types.js';
import {
  downloadGithubPlugin,
  cloneGitRepositoryPlugin,
  type ExtractedGithubPlugin,
} from './github-archive.js';
import {
  resolveGitRepositorySource,
  validateGithubPluginSource,
  validateGitRepositorySource,
  isGithubRepositoryUrl,
  type GithubPluginSource,
} from './github-source.js';

export interface GithubPluginPreview {
  readonly source: GithubPluginSource;
  readonly plugin: ReadPluginPackage;
  readonly packageSizeBytes: number;
  readonly canImport: boolean;
}

export interface PreparedGithubPluginImport extends GithubPluginPreview {
  readonly stagingRoot: string;
  discard(): Promise<void>;
}

export class GithubPluginImporter {
  constructor(private readonly options: { dataDir: string; fetchImpl: typeof fetch }) {}

  async preview(url: string, signal?: AbortSignal): Promise<GithubPluginPreview> {
    try {
      const source = await resolveGitRepositorySource(url, {
        fetchImpl: this.options.fetchImpl,
        signal,
      });
      const extracted = await this.download(source, signal);
      try {
        return await this.readPreview(source, extracted);
      } finally {
        await extracted.discard();
      }
    } catch (error) {
      throw normalizeImportError(error);
    }
  }

  async prepare(sourceInput: GithubPluginSource): Promise<PreparedGithubPluginImport> {
    let extracted: ExtractedGithubPlugin | undefined;
    try {
      const source = isGithubRepositoryUrl(sourceInput.repositoryUrl)
        ? validateGithubPluginSource(sourceInput)
        : validateGitRepositorySource(sourceInput);
      extracted = await this.download(source);
      const preview = await this.readPreview(source, extracted);
      return { ...preview, stagingRoot: extracted.rootPath, discard: extracted.discard };
    } catch (error) {
      await extracted?.discard();
      throw normalizeImportError(error);
    }
  }

  private download(
    source: GithubPluginSource,
    signal?: AbortSignal,
  ): Promise<ExtractedGithubPlugin> {
    return isGithubRepositoryUrl(source.repositoryUrl)
      ? downloadGithubPlugin(this.options.dataDir, source, this.options.fetchImpl, signal)
      : cloneGitRepositoryPlugin(this.options.dataDir, source, signal);
  }
  private async readPreview(
    source: GithubPluginSource,
    extracted: ExtractedGithubPlugin,
  ): Promise<GithubPluginPreview> {
    const plugin = await readImportedPluginPackage(extracted.rootPath, {
      dataDir: this.options.dataDir,
      createPluginData: false,
    });
    return {
      source,
      plugin,
      packageSizeBytes: extracted.packageSizeBytes,
      canImport:
        plugin.apps.length +
          plugin.skills.length +
          plugin.mcpServers.length +
          (plugin.hooks?.length ?? 0) >
        0,
    };
  }
}

function normalizeImportError(error: unknown): unknown {
  if (error instanceof PluginSystemError) return error;
  if (error instanceof PluginReaderError || error instanceof PluginPackageContractError) {
    return new PluginSystemError(error.code, error.message);
  }
  return error;
}
