import { readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isAgentBuiltinToolEnabled,
  parseAgentCapabilityConfig,
  type AgentCapabilityConfig,
} from '@mavis/config';
import {
  PromptSnapshotInvalidError,
  type PromptReadScope,
  type PromptSnapshotSource,
  type PromptReadSnapshot,
} from '@mavis/agent-runtime';

import type {
  AgentAppMode,
  AgentPromptMode,
  AgentPromptSnapshot,
  AgentPromptChannel,
  AgentStoreIdentity,
  BuiltinAgentDefinition,
} from '../contracts.js';
import {
  BUILTIN_ROSTER_FILE,
  FEATURE_FILES,
  PRIMARY_AGENT_NAME,
  PTC_SECTION_FILE,
  canonicalBuiltinName,
  defaultLocale,
  legacyNamesFor,
  surfacePromptFiles,
  toSurfaceRenderInput,
  type BuiltinRenderInput,
  type BuiltinPromptReadScope,
  type BuiltinSurfaceRenderInput,
} from './definitions.js';
import {
  createBuiltinPromptContext,
  parseFrontmatter,
  renderBuiltinTemplate,
  stripFrontmatter,
} from './prompt-renderer.js';
import { captureLocalPromptAssets } from './prompt-assets.js';
import type { PromptFileReader } from '../../prompt-config/index.js';

export {
  canonicalBuiltinName,
  legacyNamesFor,
  resolveCanonicalCapabilities,
} from './definitions.js';

export interface BuiltinCatalogOptions {
  readonly assetsDir?: string;
  readonly freezeLocalPrompts?: boolean;
  /** Reads a selected Prompt version without exposing remote templates on disk. */
  readonly promptFileReader?: PromptFileReader;
}

export interface BuiltinRenderOutput {
  readonly promptSnapshot?: AgentPromptSnapshot;
  readonly agentSystemPrompt: string;
  readonly persona?: string;
  readonly corePrompt: string;
  readonly surfacePrompt: string;
  readonly identity: AgentStoreIdentity;
  readonly assetAgentName: string;
}

export interface BuiltinCanonicalContent {
  readonly persona?: string;
  readonly systemPrompt?: string;
}

export type {
  BuiltinPtcRender,
  BuiltinRenderInput,
  BuiltinSurfaceRenderInput,
} from './definitions.js';

interface ModeAssetInput {
  readonly agentName: string;
  readonly appMode: AgentAppMode;
  readonly locale: string;
  readonly channel: AgentPromptChannel;
  readonly kind: 'persona' | 'system';
  readonly promptReadContext?: BuiltinPromptReadScope;
}

export class BuiltinAgentCatalog {
  private readonly assetsDirOverride: string | undefined;
  private readonly promptFileReader: PromptFileReader | undefined;
  private readonly freezeLocalPrompts: boolean;
  private localPromptAssets?: Promise<ReadonlyMap<string, string>>;

  constructor(options: BuiltinCatalogOptions = {}) {
    this.assetsDirOverride = options.assetsDir?.trim() || undefined;
    this.promptFileReader = options.promptFileReader;
    this.freezeLocalPrompts = options.freezeLocalPrompts === true;
  }

  async frozenPromptSource(): Promise<PromptSnapshotSource | undefined> {
    if (!this.freezeLocalPrompts) return undefined;
    const contents = await this.frozenAssets();
    const registry = JSON.parse(contents.get('managed-prompts.json') ?? '{"desktop_agent":[]}') as {
      desktop_agent: string[];
    };
    const managedKeys = new Set(registry.desktop_agent);
    const snapshot = Object.freeze({}) as PromptReadSnapshot;
    return {
      capture: async () => snapshot,
      captureBuiltin: async () => snapshot,
      read: async (selected, key) => {
        if (selected !== snapshot)
          throw new TypeError('Prompt snapshot was not captured by this source.');
        const content = contents.get(key);
        if (content !== undefined) return { kind: 'found', content };
        return managedKeys.has(key) ? { kind: 'invalid' } : { kind: 'missing' };
      },
    };
  }

  async listDefinitions(): Promise<readonly BuiltinAgentDefinition[]> {
    const names = await this.readRoster();
    return Promise.all(names.map((name) => this.readDefinition(name)));
  }

  async hasBuiltin(name: string): Promise<boolean> {
    const canonical = canonicalBuiltinName(name);
    return (await this.readRoster()).includes(canonical);
  }

  async readDefinition(name: string): Promise<BuiltinAgentDefinition> {
    const canonical = canonicalBuiltinName(name);
    if (!(await this.readRoster()).includes(canonical)) {
      throw new Error(`Built-in Agent definition is not in the roster: ${name}`);
    }
    const agentDir = join(await this.assetsDir(), canonical);
    const persona = await this.readLocalizedPersona(agentDir, 'en');
    const frontmatter = parseFrontmatter(persona ?? '').frontmatter;
    const capabilityOverride = await this.readCapabilityOverride(agentDir);
    const identity: AgentStoreIdentity = {
      ...(typeof frontmatter.display_name === 'string'
        ? { displayName: frontmatter.display_name }
        : {}),
      ...(typeof frontmatter.description === 'string'
        ? { description: frontmatter.description }
        : {}),
      ...(typeof frontmatter.avatar === 'string' ? { avatar: frontmatter.avatar } : {}),
    };
    return {
      name: canonical,
      role: canonical === PRIMARY_AGENT_NAME ? 'orchestrator' : canonical,
      legacyNames: legacyNamesFor(canonical),
      identity,
      ...(capabilityOverride ? { capabilityOverride } : {}),
    };
  }

  async render(input: BuiltinRenderInput): Promise<BuiltinRenderOutput> {
    const canonical = canonicalBuiltinName(input.agentName);
    const definition = await this.readDefinition(canonical);
    const parts = await this.renderAgentParts(canonical, input);
    const surface =
      canonical === PRIMARY_AGENT_NAME && usesV2Prompts(input) && input.surface !== 'task-child'
        ? { core: '' }
        : await this.readSurfaceParts(canonical, input);
    const sharedBase = await this.renderSharedBaseParts(input, definition.role, {
      includeAllLayer: canonical !== PRIMARY_AGENT_NAME || parts.coreTemplate === undefined,
    });
    return {
      ...(parts.persona ? { persona: parts.persona } : {}),
      corePrompt: [parts.agentPrompt.trim(), sharedBase.core.trim()].filter(Boolean).join('\n\n'),
      agentSystemPrompt: parts.agentPrompt,
      ...(parts.promptSnapshot ? { promptSnapshot: parts.promptSnapshot } : {}),
      surfacePrompt: surface.core,
      identity: definition.identity,
      assetAgentName: canonical,
    };
  }

  private async renderAgentParts(canonical: string, input: BuiltinRenderInput) {
    const [personaTemplate, coreTemplate, featurePrompts] = await Promise.all([
      this.readPromptAsset(canonical, input, 'persona'),
      this.readPromptAsset(canonical, input, 'system'),
      this.renderFeaturePrompts(canonical, input),
    ]);
    const context = this.context(input, featurePrompts);
    const persona = personaTemplate
      ? stripFrontmatter(this.renderTemplate(personaTemplate, context, `${canonical}/persona`))
      : undefined;
    const agentPrompt = coreTemplate
      ? this.renderTemplate(coreTemplate, context, `${canonical}/system`)
      : '';
    const promptSnapshot: AgentPromptSnapshot | undefined = usesV2Prompts(input)
      ? {
          mode: resolvePromptMode(input),
          ...(input.promptVersion ? { version: input.promptVersion } : {}),
          template: coreTemplate ?? '',
          systemPrompt: agentPrompt,
        }
      : undefined;
    return { persona, coreTemplate, agentPrompt, promptSnapshot };
  }

  /**
   * Renders the PTC section with the Turn's own context (tool switches) before
   * the main templates insert it. Read from the bundled assets only, never from
   * a remote Prompt version: it is exempt from desktop_agent delivery, so a
   * remote bundle never has to carry it and no older client ever sees it.
   */
  async renderPtcSection(input: BuiltinRenderInput): Promise<string> {
    const template = await this.readPromptAssetFile(undefined, PTC_SECTION_FILE);
    if (template === undefined)
      throw new Error(`Mandatory V2 PTC prompt is missing: ${PTC_SECTION_FILE}.`);
    return this.renderTemplate(template, this.context(input, {}), PTC_SECTION_FILE).trim();
  }

  renderPromptSnapshot(
    input: BuiltinRenderInput,
    snapshot: AgentPromptSnapshot,
  ): AgentPromptSnapshot {
    return {
      ...snapshot,
      systemPrompt: this.renderTemplate(
        snapshot.template,
        this.context(input, {}),
        'saved V2 system',
      ),
    };
  }

  /** Reads only the built-in Agent's own prompt assets; shared base layers are excluded. */
  async readCanonicalContent(input: BuiltinRenderInput): Promise<BuiltinCanonicalContent> {
    const rendered = await this.renderAgentParts(canonicalBuiltinName(input.agentName), input);
    return {
      ...(rendered.persona === undefined ? {} : { persona: rendered.persona }),
      ...(rendered.coreTemplate === undefined ? {} : { systemPrompt: rendered.agentPrompt }),
    };
  }

  async renderSurfacePrompt(input: BuiltinSurfaceRenderInput): Promise<string> {
    const files = surfacePromptFiles(input.surface);
    const custom = await this.readSurfaceOverride(input.agentConfigDir, files.fallback);
    const renderInput = toSurfaceRenderInput(input);
    const defaults = await this.readSurfaceParts('_default', renderInput);
    const rendered = custom ?? defaults.core;
    return this.ensureDelegatedTaskContract(rendered, renderInput, defaults.core);
  }

  async renderSharedBasePrompt(
    input: BuiltinRenderInput,
    agentRole: string,
    options: { readonly includeAllLayer?: boolean } = {},
  ): Promise<string> {
    const parts = await this.renderSharedBaseParts(input, agentRole, options);
    return parts.core;
  }

  async renderSharedBaseParts(
    input: BuiltinRenderInput,
    agentRole: string,
    options: { readonly includeAllLayer?: boolean } = {},
  ): Promise<{ readonly core: string }> {
    const root = usesV2Prompts(input) ? '_v2' : '_default';
    const files = [
      ...(options.includeAllLayer === false ? [] : ['prompt-base-all']),
      ...(!usesV2Prompts(input) &&
      process.platform === 'win32' &&
      isAgentBuiltinToolEnabled(input.capabilities, 'bash')
        ? ['prompt-base-windows']
        : []),
      ...(agentRole === 'orchestrator' ? [] : ['prompt-base-worker']),
    ];
    const core: string[] = [];
    for (const file of files) {
      const templates = await this.readLayerTemplates(input, root, `${file}.md.hbs`);
      if (templates.core === undefined)
        throw new Error(`Mandatory local-runtime-v2 base prompt is missing: ${file}.md.hbs.`);
      const parts = this.renderLayerParts(input, `${root}/${file}`, templates);
      core.push(parts.core);
    }
    return {
      core: core
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n'),
    };
  }

  private renderLayerParts(
    input: BuiltinRenderInput,
    source: string,
    templates: { readonly core?: string },
  ) {
    const context = {
      ...this.context(input, {}),
      layer: {
        base: source.endsWith('/prompt-base-all'),
        worker: source.endsWith('/prompt-base-worker'),
        root: source.endsWith('/prompt-session-root.md.hbs'),
        branch: source.endsWith('/prompt-session-branch.md.hbs'),
      },
    };
    return {
      core: this.renderTemplate(templates.core ?? '', context, `${source}/core`).trim(),
    };
  }

  private async readLayerTemplates(input: BuiltinRenderInput, root: string, file: string) {
    const v2 = usesV2Prompts(input);
    if (v2) {
      return {
        core: await this.readPromptAssetFile(
          v2PromptReadContext(input),
          '_v2/AGENT_CONTEXT.md.hbs',
        ),
      };
    }
    const context = input.promptReadContext;
    const directory = root;
    const fallback = file.replace(/\.hbs$/u, '');
    const core = await this.readFirstPromptAsset(context, [
      posix.join(directory, file),
      posix.join(directory, fallback),
    ]);
    return { core };
  }

  private async readSurfaceOverride(
    agentConfigDir: string | undefined,
    fallback: string,
  ): Promise<string | undefined> {
    return agentConfigDir ? this.readOptionalFile(join(agentConfigDir, fallback)) : undefined;
  }

  private ensureDelegatedTaskContract(
    rendered: string,
    input: BuiltinRenderInput,
    contract: string,
  ): string {
    if (input.surface !== 'task-child' || rendered.includes('## Delegated Task Contract')) {
      return rendered;
    }
    return [rendered.trim(), contract].filter(Boolean).join('\n\n');
  }

  private async readSurfaceParts(canonical: string, input: BuiltinRenderInput) {
    const files = surfacePromptFiles(input.surface);
    const roots = usesV2Prompts(input) ? ['_v2'] : [canonical, '_default'];
    for (const root of new Set(roots)) {
      const templates = await this.readLayerTemplates(input, root, files.template);
      if (templates.core !== undefined) {
        return this.renderLayerParts(input, `${root}/${files.template}`, templates);
      }
    }
    if (input.promptProfile === 'tui')
      throw new Error(`Mandatory TUI surface prompt is missing: ${files.template}.`);
    return { core: '' };
  }

  private async readPromptAsset(
    canonical: string,
    input: BuiltinRenderInput,
    kind: 'persona' | 'system',
  ): Promise<string | undefined> {
    const v2 = usesV2Prompts(input);
    if (v2) {
      if (kind === 'persona') return undefined;
      const path =
        canonical === PRIMARY_AGENT_NAME
          ? posix.join('_v2', resolvePromptMode(input), 'SYSTEM.md.hbs')
          : posix.join('_v2', `${canonical}.md.hbs`);
      const template = await this.readPromptAssetFile(v2PromptReadContext(input), path);
      if (template === undefined) throw new Error(`Mandatory V2 Agent prompt is missing: ${path}.`);
      return template;
    }
    const promptReadContext = input.promptReadContext;
    if (canonical === PRIMARY_AGENT_NAME) {
      const mode = input.appMode;
      const template = await this.readModeAsset({
        agentName: canonical,
        appMode: mode,
        locale: 'en',
        channel: input.promptChannel,
        kind,
        promptReadContext,
      });
      if (template === undefined)
        throw new Error(`Mandatory ${mode} Mavis ${kind} prompt is missing.`);
      return template;
    }
    const directory = canonical;
    return kind === 'persona'
      ? this.readLocalizedPromptAsset(promptReadContext, directory, 'en')
      : this.readFirstPromptAsset(promptReadContext, [
          posix.join(directory, 'system-prompt.md.hbs'),
          posix.join(directory, 'system-prompt.md'),
        ]);
  }

  async resolveAssetsDir(): Promise<string> {
    return this.assetsDir();
  }

  async readGreetingTemplate(
    locale = defaultLocale(),
    promptReadContext?: BuiltinPromptReadScope,
  ): Promise<string> {
    const localized = locale.toLowerCase().startsWith('zh') ? 'greeting-zh.md' : 'greeting.md';
    return (
      (await this.readPromptAssetFile(promptReadContext, localized)) ??
      (await this.readPromptAssetFile(promptReadContext, 'greeting.md')) ??
      ''
    );
  }

  private async readRoster(): Promise<string[]> {
    const raw = await readFile(join(await this.assetsDir(), BUILTIN_ROSTER_FILE), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Built-in Agent roster must be an array.');
    const names = parsed.filter((value): value is string => typeof value === 'string');
    return names.map((name) => canonicalBuiltinName(name));
  }

  private async readCapabilityOverride(
    agentDir: string,
  ): Promise<AgentCapabilityConfig | undefined> {
    const raw = await this.readOptionalFile(join(agentDir, 'agent.md'));
    if (raw === undefined) return undefined;
    const frontmatter = parseFrontmatter(raw).frontmatter;
    const capabilityFields = Object.fromEntries(
      ['persona', 'tools', 'builtinTools', 'skills', 'features']
        .filter((key) => Object.hasOwn(frontmatter, key))
        .map((key) => [key, frontmatter[key]]),
    );
    return Object.keys(capabilityFields).length > 0
      ? parseAgentCapabilityConfig(capabilityFields, `${agentDir}/agent.md`)
      : undefined;
  }

  private async renderFeaturePrompts(
    canonical: string,
    input: BuiltinRenderInput,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const v2 = usesV2Prompts(input);
    if (v2) return result;
    const featureDir = posix.join(canonical, 'features');
    for (const [key, fileName] of Object.entries(FEATURE_FILES)) {
      if (key === 'cron' && input.cronEnabled === false) {
        result[key] = '';
        continue;
      }
      const template = await this.readPromptAssetFile(
        input.promptReadContext,
        posix.join(featureDir, fileName),
      );
      if (template === undefined) {
        result[key] = '';
        continue;
      }
      const rendered = this.renderTemplate(
        template,
        this.context(input, result),
        `features/${fileName}`,
      );
      result[key] = rendered;
    }
    return result;
  }

  private context(
    input: BuiltinRenderInput,
    featurePrompts: Readonly<Record<string, string>>,
  ): Record<string, unknown> {
    return createBuiltinPromptContext(input, featurePrompts);
  }

  private renderTemplate(
    template: string,
    context: Record<string, unknown>,
    source: string,
  ): string {
    return renderBuiltinTemplate(template, context, source);
  }

  private async readModeAsset(input: ModeAssetInput): Promise<string | undefined> {
    const base = posix.join(input.agentName, 'modes', input.appMode);
    const channels: AgentPromptChannel[] =
      input.channel === 'internal' ? ['internal', 'online'] : ['online'];
    for (const candidate of channels) {
      const dir = posix.join(base, candidate);
      const template =
        input.kind === 'system'
          ? await this.readPromptAssetFile(
              input.promptReadContext,
              posix.join(dir, 'SYSTEM.md.hbs'),
            )
          : await this.readLocalizedPromptAsset(
              input.promptReadContext,
              dir,
              input.locale,
              '.md.hbs',
            );
      if (template !== undefined) return template;
    }
    return undefined;
  }

  private async readLocalizedPersona(
    dir: string,
    locale: string,
    suffix = '.md',
  ): Promise<string | undefined> {
    const lang = locale.trim().toLowerCase().split(/[-_]/u)[0] || 'en';
    const candidates = [
      lang.startsWith('zh') ? `PERSONA-zh${suffix}` : `PERSONA-${lang}${suffix}`,
      `PERSONA${suffix}`,
      'PERSONA.md',
    ];
    return this.readFirst(dir, candidates);
  }

  private async readLocalizedPromptAsset(
    promptReadContext: BuiltinPromptReadScope | undefined,
    relativeDir: string,
    locale: string,
    suffix = '.md',
  ): Promise<string | undefined> {
    const lang = locale.trim().toLowerCase().split(/[-_]/u)[0] || 'en';
    const candidates = [
      lang.startsWith('zh') ? `PERSONA-zh${suffix}` : `PERSONA-${lang}${suffix}`,
      `PERSONA${suffix}`,
      'PERSONA.md',
    ].map((name) => posix.join(relativeDir, name));
    return this.readFirstPromptAsset(promptReadContext, candidates);
  }

  private async readFirstPromptAsset(
    promptReadContext: BuiltinPromptReadScope | undefined,
    relativePaths: readonly string[],
  ): Promise<string | undefined> {
    for (const relativePath of relativePaths) {
      const content = await this.readPromptAssetFile(promptReadContext, relativePath);
      if (content !== undefined) return content;
    }
    return undefined;
  }

  private async readPromptAssetFile(
    promptReadContext: BuiltinPromptReadScope | undefined,
    relativePath: string,
  ): Promise<string | undefined> {
    if (isPromptReadScope(promptReadContext)) {
      const result = await promptReadContext.source.read(promptReadContext.snapshot, relativePath);
      if (result.kind === 'found') return result.content;
      if (result.kind === 'invalid') {
        throw new PromptSnapshotInvalidError(
          `Built-in Agent prompt cannot be read: ${relativePath}`,
        );
      }
      return undefined;
    }
    if (promptReadContext) {
      if (!this.promptFileReader) {
        throw new Error('Built-in Prompt context was supplied without a PromptFileReader.');
      }
      return this.promptFileReader.read(promptReadContext, relativePath);
    }
    if (this.freezeLocalPrompts) {
      return (await this.frozenAssets()).get(relativePath);
    }
    return this.readOptionalFile(join(await this.assetsDir(), relativePath));
  }

  private frozenAssets(): Promise<ReadonlyMap<string, string>> {
    this.localPromptAssets ??= this.captureLocalAssets();
    return this.localPromptAssets;
  }

  private async captureLocalAssets(): Promise<ReadonlyMap<string, string>> {
    return captureLocalPromptAssets(await this.assetsDir());
  }

  private async readFirst(dir: string, fileNames: readonly string[]): Promise<string | undefined> {
    for (const fileName of fileNames) {
      const content = await this.readOptionalFile(join(dir, fileName));
      if (content !== undefined) return content;
    }
    return undefined;
  }

  private async readOptionalFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  private async assetsDir(): Promise<string> {
    const configured = process.env.MAVIS_BUILTIN_AGENTS_V2_DIR?.trim() || this.assetsDirOverride;
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = configured
      ? [configured]
      : [
          resolve(here, '../../../../assets/agents'),
          resolve(here, 'assets/agents'),
          resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents'),
          resolve(process.cwd(), 'assets/agents'),
          resolve(process.cwd(), 'assets/local-runtime-v2/agents'),
        ];
    for (const candidate of candidates) {
      const roster = await this.readOptionalFile(join(candidate, BUILTIN_ROSTER_FILE));
      if (roster !== undefined) return candidate;
    }
    throw new Error('Local Runtime V2 built-in Agent assets are missing.');
  }
}

function resolvePromptMode(input: BuiltinRenderInput): AgentPromptMode {
  return input.promptMode ?? (input.promptProfile === 'tui' ? 'tui' : input.appMode);
}

function usesV2Prompts(input: BuiltinRenderInput): boolean {
  return (
    input.promptProfile === 'desktop' ||
    input.promptProfile === 'tui' ||
    input.promptMode !== undefined
  );
}

function v2PromptReadContext(input: BuiltinRenderInput): BuiltinPromptReadScope | undefined {
  return input.promptProfile === 'desktop' ? input.promptReadContext : undefined;
}

function isPromptReadScope(value: BuiltinPromptReadScope | undefined): value is PromptReadScope {
  return Boolean(value && 'source' in value && 'snapshot' in value);
}
