import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { TuiPluginManager } from '../../src/tui/features/plugin/manager.js';
import { CURSOR_MARKER } from '../../src/tui/engine/public.js';
import { stripAnsi, visibleWidth } from '../../src/tui/rendering/text.js';

const plugins = [
  {
    pluginId: 'docs@official',
    name: 'docs',
    displayName: 'Documents',
    marketplace: 'official' as const,
    description: 'Create and edit documents',
    installed: true,
    enabled: true,
    capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 1 },
  },
  {
    pluginId: 'calendar@official',
    name: 'calendar',
    displayName: 'Calendar',
    marketplace: 'official' as const,
    installed: false,
    enabled: false,
    capabilities: { appCount: 1, mcpServerCount: 0, skillCount: 0 },
  },
  {
    pluginId: 'notes@local',
    name: 'notes',
    displayName: 'Notes',
    marketplace: 'local' as const,
    installed: true,
    enabled: false,
    capabilities: { appCount: 0, mcpServerCount: 1, skillCount: 0, agentCount: 2 },
  },
];

function createManager() {
  const options = {
    plugins,
    onInstall: vi.fn(async (plugin) => ({ ...plugin, installed: true, enabled: true })),
    onRemove: vi.fn(async (plugin) => ({ ...plugin, installed: false, enabled: false })),
    onSetEnabled: vi.fn(async (plugin, enabled) => ({ ...plugin, enabled })),
    onRefresh: vi.fn(async () => plugins),
    onCancel: vi.fn(),
    requestRender: vi.fn(),
  };
  return { manager: new TuiPluginManager(options), options };
}

describe('TuiPluginManager', () => {
  it('renders a searchable logical catalog with source tabs and bounded lines', () => {
    const { manager } = createManager();
    const lines = manager.render(74);
    const rendered = stripVTControlCharacters(lines.join('\n'));

    expect(lines.every((line) => visibleWidth(line) <= 74)).toBe(true);
    expect(rendered).toContain('Plugins');
    expect(rendered).toContain('[All Plugins]');
    expect(rendered).toContain('Installed (2)');
    expect(rendered).toContain('Documents');
    expect(rendered).toContain('Calendar');
  });

  it('counts Plugin subagents only when the Plugin has any', () => {
    const { manager } = createManager();
    const rendered = stripVTControlCharacters(manager.render(120).join('\n'));

    expect(rendered).toContain('0 apps · 1 MCP · 0 skills · 2 subagents');
    expect(rendered).toContain('1 apps · 0 MCP · 0 skills');
    expect(rendered).not.toContain('0 skills · 0 subagents');
  });

  it('filters by typing, cycles tabs, and mutates the selected Plugin', async () => {
    const { manager, options } = createManager();
    manager.handleInput('c');
    manager.handleInput('a');
    expect(stripVTControlCharacters(manager.render(80).join('\n'))).toContain('Calendar');
    expect(stripVTControlCharacters(manager.render(80).join('\n'))).not.toContain('Documents');

    manager.handleInput('\r');
    await vi.waitFor(() =>
      expect(options.onInstall).toHaveBeenCalledWith(expect.objectContaining({ name: 'calendar' })),
    );
    expect(stripVTControlCharacters(manager.render(80).join('\n'))).toContain('[*]');

    manager.handleInput('\x1b');
    manager.handleInput('\t');
    expect(stripVTControlCharacters(manager.render(80).join('\n'))).toContain('[Installed (3)]');
    manager.handleInput(' ');
    await vi.waitFor(() => expect(options.onSetEnabled).toHaveBeenCalled());
  });

  it('loads an initial search query without interpreting spaces as actions', () => {
    const { options } = createManager();
    const manager = new TuiPluginManager({ ...options, initialQuery: 'office tools' });
    const rendered = stripVTControlCharacters(manager.render(80).join('\n'));

    expect(rendered).toContain('Search: office tools');
    expect(options.onSetEnabled).not.toHaveBeenCalled();
  });

  it('delegates Delete to the active Pi search Input', () => {
    const { manager, options } = createManager();
    manager.handleInput('d');
    manager.handleInput('o');
    manager.handleInput('c');
    manager.handleInput('x');
    manager.handleInput('\u001B[D');
    manager.handleInput('\u001B[3~');
    manager.handleInput('\u0001');
    manager.handleInput('\u0004');

    const rendered = stripVTControlCharacters(manager.render(80).join('\n'));
    expect(rendered).toContain('Search: oc');
    expect(options.onSetEnabled).not.toHaveBeenCalled();
    expect(options.onRemove).not.toHaveBeenCalled();
  });

  it('keeps Space as a Plugin action after filtering', async () => {
    const { manager, options } = createManager();
    manager.handleInput('d');
    manager.handleInput('o');
    manager.handleInput('c');

    manager.handleInput(' ');

    await vi.waitFor(() =>
      expect(options.onSetEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'docs' }),
        false,
      ),
    );
    const rendered = stripVTControlCharacters(manager.render(80).join('\n'));
    expect(rendered).toContain('Search: doc');
    expect(rendered).toContain('[-] Documents');
  });

  it.each(['\u001B[32;2u', '\u001B[27;2;32~'])(
    'keeps Shift+Space available for multi-word search with %j',
    (shiftSpace) => {
      const { manager, options } = createManager();
      for (const character of 'create') manager.handleInput(character);
      manager.handleInput(shiftSpace);
      for (const character of 'documents') manager.handleInput(character);

      const rendered = stripVTControlCharacters(manager.render(120).join('\n'));
      expect(rendered).toContain('Search: create documents');
      expect(options.onSetEnabled).not.toHaveBeenCalled();
    },
  );

  it('keeps Space and Delete as Plugin actions while the Pi search Input is empty', async () => {
    const { manager, options } = createManager();
    manager.handleInput(' ');
    await vi.waitFor(() => expect(options.onSetEnabled).toHaveBeenCalledOnce());

    manager.handleInput('\u001B[3~');
    await vi.waitFor(() => expect(options.onRemove).toHaveBeenCalledOnce());
  });

  it('uses the Pi Input cursor marker and accepts an IME commit as one input event', () => {
    const { manager } = createManager();
    manager.focused = true;
    manager.handleInput('文档');
    manager.handleInput('\u001B[D');
    manager.handleInput('新');

    const lines = manager.render(80);
    const searchLine = lines.find((line) => stripVTControlCharacters(line).startsWith('Search: '));
    expect(searchLine).toBeDefined();
    expect(searchLine).toContain(CURSOR_MARKER);
    expect(stripAnsi(searchLine ?? '')).toContain('Search: 文新档');
    expect(visibleWidth((searchLine ?? '').slice(0, searchLine?.indexOf(CURSOR_MARKER)))).toBe(12);
  });

  it('shows mutation and refresh failures without losing state or remaining busy', async () => {
    const { options } = createManager();
    options.onSetEnabled
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockImplementation(async (plugin, enabled) => ({ ...plugin, enabled }));
    options.onRefresh.mockRejectedValueOnce(new Error('registry unavailable'));
    const manager = new TuiPluginManager(options);

    manager.handleInput(' ');
    await vi.waitFor(() => expect(options.onSetEnabled).toHaveBeenCalledTimes(1));
    let rendered = stripVTControlCharacters(manager.render(80).join('\n'));
    expect(rendered).toContain("Couldn't update Documents");
    expect(rendered).toContain('[*] Documents');

    manager.handleInput(' ');
    await vi.waitFor(() => expect(options.onSetEnabled).toHaveBeenCalledTimes(2));
    rendered = stripVTControlCharacters(manager.render(80).join('\n'));
    expect(rendered).toContain('[-] Documents');

    manager.handleInput('\x12');
    await vi.waitFor(() => expect(options.onRefresh).toHaveBeenCalledTimes(1));
    rendered = stripVTControlCharacters(manager.render(80).join('\n'));
    expect(rendered).toContain("Couldn't refresh Plugins");
    expect(rendered).toContain('Documents');

    manager.handleInput('\x12');
    await vi.waitFor(() => expect(options.onRefresh).toHaveBeenCalledTimes(2));
    expect(stripVTControlCharacters(manager.render(80).join('\n'))).toContain(
      'Plugin catalogs refreshed.',
    );
  });

  it('directs an incomplete Plugin login back through /login', async () => {
    const { options } = createManager();
    options.onSetEnabled.mockRejectedValueOnce(
      Object.assign(new Error('PLUGIN_AUTH_REQUIRED'), { code: 'PLUGIN_AUTH_REQUIRED' }),
    );
    const manager = new TuiPluginManager(options);

    manager.handleInput(' ');
    await vi.waitFor(() => expect(options.onSetEnabled).toHaveBeenCalledOnce());

    const rendered = stripVTControlCharacters(manager.render(100).join('\n'));
    expect(rendered).toContain('Run /login, then retry.');
  });

  it('ignores a mutation result after the manager is disposed', async () => {
    let resolveMutation: ((plugin: (typeof plugins)[number]) => void) | undefined;
    const mutation = new Promise<(typeof plugins)[number]>((resolve) => {
      resolveMutation = resolve;
    });
    const { manager, options } = createManager();
    options.onSetEnabled.mockReturnValueOnce(mutation);
    manager.handleInput(' ');
    await vi.waitFor(() => expect(options.onSetEnabled).toHaveBeenCalledOnce());
    const rendersBeforeDispose = options.requestRender.mock.calls.length;

    manager.dispose();
    const installedPlugin = plugins.find((plugin) => plugin.pluginId === 'docs@official');
    if (!installedPlugin) throw new Error('Missing installed Plugin fixture.');
    resolveMutation?.({ ...installedPlugin, enabled: false });
    await mutation;
    await Promise.resolve();

    expect(options.requestRender).toHaveBeenCalledTimes(rendersBeforeDispose);
    expect(stripVTControlCharacters(manager.render(80).join('\n'))).toContain('[*] Documents');
  });
});
