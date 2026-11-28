import { parsePluginMentions } from '@mavis/shared/plugin-mention';

export interface EffectivePluginToolGroup {
  readonly source: string;
  readonly tools: readonly string[];
  /** Deferred tools must be discovered before they can be invoked. */
  readonly access?: 'direct' | 'tool_search';
}

export interface EffectivePluginCapabilityInventory {
  readonly name: string;
  /** Human-facing manifest name; `name` stays the machine identifier. */
  readonly displayName?: string;
  readonly pluginId?: string;
  /** Manifest declarations, not a live connection or authorization claim. */
  readonly appCliProviders?: readonly string[];
  readonly appTools: readonly EffectivePluginToolGroup[];
  readonly mcpTools: readonly EffectivePluginToolGroup[];
  readonly skills: readonly string[];
  /** Native host tools present in the final executable catalog. */
  readonly hostTools?: readonly EffectivePluginToolGroup[];
}

/**
 * Resolve canonical `@Plugin` references against the enabled capability
 * inventory for this turn. References must be whitespace-delimited so email
 * addresses, prefixes, and punctuation-attached plain text are not treated as
 * an explicit Plugin selection.
 */
export function detectPluginReferencesForMessages<T extends EffectivePluginCapabilityInventory>(
  messages: readonly { content?: string }[],
  fallbackText: string,
  plugins: readonly T[] | undefined,
): T[] {
  if (!plugins || plugins.length === 0) return [];
  const texts =
    messages.length === 0
      ? [fallbackText]
      : messages.flatMap((message) => (message.content?.trim() ? [message.content] : []));
  const selected: T[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    for (const match of detectReferencesInText(text, plugins)) {
      const key = match.pluginId ?? normalizedName(match.name);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(match);
    }
  }
  return selected;
}

export interface PluginReferenceReminderOptions {
  /**
   * This Turn runs with PTC (programmatic tool calling). Tool Search results
   * are then called inside run_code and no name-routed mcp_invoke exists, so
   * the reminder names the run_code call form, worded like the PTC Tool Search
   * hint. Without PTC the text is unchanged.
   */
  readonly ptc?: boolean;
  /**
   * Subset of `unavailablePluginIds`: Plugins whose capability is a host capability (Computer
   * Use) that this Session has not enabled. Their Skill may still be readable, but nothing it
   * describes can run, so the line says how the user enables it instead of the generic text.
   */
  readonly hostCapabilityUnavailablePluginIds?: readonly string[];
  /**
   * Subset of `hostCapabilityUnavailablePluginIds`: this Session cannot run the capability itself,
   * but the user's message this turn authorized handing it to a task this Session dispatches (a
   * coordinator). The line then says so instead of telling the user it is unavailable.
   */
  readonly hostCapabilityDelegablePluginIds?: readonly string[];
}

const PTC_RUN_CODE_CALL =
  'inside run_code like any other tool: `await tools.<name>(args)`, or `await tools["<name>"](args)` when the name contains characters such as `-`.';

/** The `via ...` marker of a capability discovered through Tool Search. */
function toolSearchAccess(ptc: boolean): string {
  return ptc ? 'via `tool_search` + `run_code`' : 'via `tool_search` + `mcp_invoke`';
}

/** Render one self-contained reminder for every Plugin selected in this turn. */
export function buildPluginReferenceReminder(
  plugins: readonly EffectivePluginCapabilityInventory[],
  unavailablePluginIds: readonly string[] = [],
  options: PluginReferenceReminderOptions = {},
): string | undefined {
  if (plugins.length === 0 && unavailablePluginIds.length === 0) return undefined;
  const ptc = options.ptc === true;
  const hostCapabilityUnavailable = new Set(options.hostCapabilityUnavailablePluginIds ?? []);
  const hostCapabilityDelegable = new Set(options.hostCapabilityDelegablePluginIds ?? []);
  const blocks = plugins.slice(0, 8).map((plugin) => {
    const name = inlineCode(plugin.name);
    const displayName = pluginDisplayName(plugin);
    const displayNameAttribute = displayName ? ` display_name="${escapeXml(displayName)}"` : '';
    const nameAttributes = `name="${escapeXml(plugin.name)}"${displayNameAttribute}`;
    const detail = [
      `<selected-plugin ${nameAttributes}>`,
      `Referenced as \`@${name}\`.`,
      ...(displayName
        ? [
            `Its display name is ${escapeXml(displayName)}. \`${name}\` is only an identifier; call this Plugin ${escapeXml(displayName)} in replies and do not equate it with any other service.`,
          ]
        : []),
      '',
      ...(plugin.appCliProviders?.length
        ? [
            '<app-cli-providers>',
            ...[...new Set(plugin.appCliProviders)]
              .sort()
              .map(
                (provider) =>
                  `- app \`${inlineCode(provider)}\`${
                    displayName && provider === plugin.name ? ` (${escapeXml(displayName)})` : ''
                  } via mcode-tools`,
              ),
            'These are Plugin declarations, not proof of a current connection.',
            'After loading mcode-tools-master, discover tools for each listed App relevant to the request by running `mcode-tools connector tools --keyword "app_name"` through Bash. Replace app_name with the exact App identifier listed above, not the Plugin name or a translated display name. Use the App identifier alone to list all matching tool names and descriptions before selecting a tool.',
            'The keyword matches tool names and descriptions, so verify that each selected tool belongs to the intended App. Inspect its schema with `mcode-tools connector tool <tool_name>` before calling it. An empty or partial result does not prove the App is disconnected; check provider_failures and, if needed, retry discovery without a keyword.',
            '</app-cli-providers>',
          ]
        : [
            '<connected-app-tools>',
            formatToolGroups(plugin.appTools, 'app', ptc),
            '</connected-app-tools>',
          ]),
      '',
      '<plugin-mcp-tools>',
      formatToolGroups(plugin.mcpTools, 'server', ptc),
      '</plugin-mcp-tools>',
      '',
      ...(plugin.hostTools
        ? [
            '<plugin-host-tools>',
            formatToolGroups(plugin.hostTools, 'host', ptc),
            '</plugin-host-tools>',
            '',
          ]
        : []),
      '<plugin-skills>',
      formatSkills(plugin.skills),
      '</plugin-skills>',
      '</selected-plugin>',
    ].join('\n');
    return detail.length <= 4096
      ? detail
      : `<selected-plugin name="${escapeXml(plugin.name).slice(0, 512)}"${displayNameAttribute}>\nCapability details omitted to fit the context limit. Use this Plugin's tool provenance and Skill namespace in the available catalogs.\n</selected-plugin>`;
  });

  const bounded: string[] = [];
  let remaining = 12_288;
  let omitted = plugins.length > 8 || unavailablePluginIds.length > 8;
  for (const block of [
    ...blocks,
    ...unavailablePluginIds
      .slice(0, 8)
      .map((id) =>
        hostCapabilityDelegable.has(id)
          ? `Selected Plugin \`${inlineCode(id)}\` (电脑操控, Computer Use): you cannot operate the desktop yourself, because its desktop control tools (computer_*) are not in your tools. The user's message this turn authorizes a task you dispatch to use it: pass computer_use: true on the assignment_create or assignment_send call for the task that needs it. Do not tell the user desktop control is unavailable or ask them to select it again. Do not load its Skill, and do not use shell, AppleScript or browser automation yourself instead.`
          : hostCapabilityUnavailable.has(id)
            ? `Selected Plugin \`${inlineCode(id)}\` is not enabled in this session: its desktop control tools (computer_*) are not available in this turn, so its Skill cannot act even if it can be read. Tell the user desktop control is not available in this turn. Do not guess why: in a desktop conversation it may work after they select @电脑操控 (Computer Use) themselves in a message, provided Computer Use is turned on; it may also be off in settings or unsupported for this kind of conversation. Do not load its Skill as a substitute, do not use shell, AppleScript or browser automation instead, and do not enable it automatically.`
            : `Selected Plugin \`${inlineCode(id)}\` is unavailable for this turn. Tell the user it could not be used; do not substitute a same-named Plugin or enable/install it automatically.`,
      ),
  ]) {
    if (block.length + 2 > remaining) {
      omitted = true;
      continue;
    }
    bounded.push(block);
    remaining -= block.length + 2;
  }

  return [
    '<system-reminder>',
    'The user explicitly selected the following Plugin capabilities for this request.',
    'Prefer them when relevant; other tools remain available if needed.',
    '',
    bounded.join('\n\n'),
    ...(omitted ? ['Additional selected capabilities omitted to fit the context limit.'] : []),
    '',
    'Use the listed Plugin capabilities through their stated access paths; current tool schemas govern direct calls. Lists may be truncated.',
    'Do not invent or claim unavailable Plugin capabilities.',
    ...(plugins.some((plugin) => plugin.appCliProviders?.length)
      ? [
          'For App access, load mcode-tools-master and use Bash when available. If Bash or the Skill is unavailable, report that this Agent cannot use App tools; do not assume a direct fallback. CLI results determine current availability and authorization.',
          'When the selected Plugin declares an App relevant to the request, discover that App before substituting general web search. Do not treat an empty direct App tool list as absence of App capabilities.',
        ]
      : []),
    ...(plugins.some((plugin) =>
      [...plugin.appTools, ...plugin.mcpTools, ...(plugin.hostTools ?? [])].some(
        (group) => group.access === 'tool_search',
      ),
    )
      ? [
          ptc
            ? `For capabilities marked \`via tool_search + run_code\`, discover the exact tool with \`tool_search\`, read its complete parameter schema, then call it ${PTC_RUN_CODE_CALL}`
            : 'For capabilities marked `via tool_search + mcp_invoke`, discover the exact tool with `tool_search`, read its complete parameter schema, then call it through `mcp_invoke`.',
        ]
      : []),
    'Before following a listed Skill, call the `skill` tool with its exact name.',
    'The existing tool schemas and loaded SKILL.md content are authoritative.',
    '</system-reminder>',
  ].join('\n');
}

function pluginDisplayName(plugin: EffectivePluginCapabilityInventory): string | undefined {
  const displayName = plugin.displayName?.trim();
  return displayName && displayName !== plugin.name ? displayName.slice(0, 256) : undefined;
}

function detectReferencesInText<T extends EffectivePluginCapabilityInventory>(
  text: string,
  plugins: readonly T[],
): T[] {
  const linked = parsePluginMentions(text);
  let plainText = text;
  for (const mention of [...linked].reverse())
    plainText = `${plainText.slice(0, mention.start)}${' '.repeat(mention.end - mention.start)}${plainText.slice(mention.end)}`;
  const normalizedText = plainText.normalize('NFKC');
  const matches: Array<{ index: number; plugin: T }> = [];
  for (const plugin of plugins) {
    const explicit = linked.find((mention) => mention.pluginId === plugin.pluginId);
    if (explicit) {
      matches.push({ index: explicit.start, plugin });
      continue;
    }
    const name = normalizedName(plugin.name);
    if (
      !name ||
      plugins.filter((candidate) => normalizedName(candidate.name) === name).length !== 1
    )
      continue;
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=\\s|$)`, 'giu');
    const match = pattern.exec(normalizedText);
    if (!match) continue;
    matches.push({ index: match.index + (match[1]?.length ?? 0), plugin });
  }
  matches.sort((left, right) => left.index - right.index);
  return matches.map((match) => match.plugin);
}

function formatToolGroups(
  groups: readonly EffectivePluginToolGroup[],
  label: 'app' | 'server' | 'host',
  ptc: boolean,
): string {
  if (groups.length === 0) return 'none';
  return [...groups]
    .slice(0, 16)
    .sort((left, right) => {
      const sourceOrder = normalizedName(left.source).localeCompare(normalizedName(right.source));
      if (sourceOrder !== 0) return sourceOrder;
      return (left.access ?? 'direct').localeCompare(right.access ?? 'direct');
    })
    .map((group) => {
      const tools = formatToolNames(group.tools);
      const access = group.access === 'tool_search' ? ` ${toolSearchAccess(ptc)}` : '';
      return `- ${label} \`${inlineCode(group.source)}\`${access}: ${tools || 'none'}`;
    })
    .join('\n');
}

function formatToolNames(tools: readonly string[]): string {
  return [...new Set(tools)]
    .slice(0, 32)
    .sort((left, right) => normalizedName(left).localeCompare(normalizedName(right)))
    .map((tool) => `\`${inlineCode(tool)}\``)
    .join(', ');
}

function formatSkills(skills: readonly string[]): string {
  if (skills.length === 0) return 'none';
  return [...new Set(skills)]
    .slice(0, 32)
    .sort((left, right) => normalizedName(left).localeCompare(normalizedName(right)))
    .map((skill) => `- \`${inlineCode(skill)}\``)
    .join('\n');
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function inlineCode(value: string): string {
  return escapeXml(value).replace(/[\\`]/gu, '\\$&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}
