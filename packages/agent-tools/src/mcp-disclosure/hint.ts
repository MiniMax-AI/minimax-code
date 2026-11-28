export interface McpToolSearchHintOptions {
  /**
   * The Turn runs with programmatic tool calling (PTC). There the hidden tools
   * are called inside run_code like any other tool and mcp_invoke does not
   * route them, so the last sentence names the run_code call form instead.
   */
  readonly ptc?: boolean;
  /**
   * Built-in on-demand tools this Turn can reach. Without their names a model
   * has to guess that a capability exists before it searches, and a visible
   * tool that looks close enough wins instead (task for "a new session").
   * MCP tools stay unnamed: they are many and change with the user's setup.
   */
  readonly builtinToolNames?: readonly string[];
}

export function renderMcpToolSearchHintBlock(options: McpToolSearchHintOptions = {}): string {
  const builtinNames = options.builtinToolNames ?? [];
  return [
    '<system-reminder>',
    'Use `tool_search` to discover permitted on-demand tools for scheduled tasks, session management, Space files, and MCP integrations.',
    ...(builtinNames.length > 0
      ? [
          `Built-in on-demand tools this turn: ${builtinNames.map((name) => `\`${name}\``).join(', ')}. Search one by name to read its definition before calling it.`,
        ]
      : []),
    ...(options.ptc
      ? [
          'Search with a keyword `query` and/or `regex`, read the returned parameter definitions, then call the',
          'chosen tool inside run_code like any other tool: `await tools.<name>(args)`, or `await tools["<name>"](args)`',
          'when the name contains characters such as `-`. Availability follows the current Agent.',
        ]
      : [
          'Search with a keyword `query` and/or `regex`, read the returned parameter definitions, then call',
          '`mcp_invoke` with the exact `tool_name` and `arguments`. Availability follows the current Agent.',
        ]),
    'Keep using direct tools when they cover the task; search results supply the definitions of additional tools.',
    '</system-reminder>',
  ].join('\n');
}
