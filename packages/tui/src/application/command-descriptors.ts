export interface TuiCommandDescriptor {
  readonly name: string;
  readonly description: string;
}

export const TUI_COMMAND_DESCRIPTORS = {
  help: {
    name: 'help',
    description: 'Show available commands',
  },
  new: {
    name: 'new',
    description: 'Start a fresh session in the current workspace',
  },
  model: {
    name: 'model',
    description: 'Choose a model',
  },
  status: {
    name: 'status',
    description: 'Show account and model status',
  },
  doctor: {
    name: 'doctor',
    description: 'Check the local config file',
  },
  context: {
    name: 'context',
    description: 'Show the Runtime-owned context snapshot',
  },
  skills: {
    name: 'skills',
    description: 'List built-in and user Skills',
  },
  mcp: {
    name: 'mcp',
    description: 'Inspect MCP capabilities and project configuration',
  },
  usage: {
    name: 'usage',
    description: 'Show session usage',
  },
  compact: {
    name: 'compact',
    description: 'Shorten the active conversation',
  },
  autocompact: {
    name: 'autocompact',
    description: "Show or set when this model's conversation is compacted automatically",
  },
  export: {
    name: 'export',
    description: 'Export the current Session as Markdown',
  },
} as const satisfies Record<string, TuiCommandDescriptor>;
