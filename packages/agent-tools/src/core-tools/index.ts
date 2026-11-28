/**
 * `@mavis/agent-tools/core-tools` — the host-neutral core tools (read / write /
 * edit / bash / grep / glob). Desktop Local*Tool classes are thin subclasses
 * bound to physical IO; other hosts construct these with their own
 * CoreToolHost. This entry must stay free of Electron, sandbox, child-process
 * and background-executor modules (test/core-tools/neutral-import-graph.test.ts).
 */

export type {
  CoreRgOptions,
  CoreRgResult,
  CoreRgRunner,
  CoreToolFileHandle,
  CoreToolFs,
  CoreToolHost,
  CoreToolStats,
} from './ports.js';
export {
  createBashToolSchema,
  LocalBashToolDef,
  LocalEditToolDef,
  LocalGlobToolDef,
  LocalGrepToolDef,
  LocalReadToolDef,
  LocalWriteToolDef,
  type LocalBashToolInput,
  type LocalEditToolInput,
  type LocalGlobToolInput,
  type LocalGrepToolInput,
  type LocalReadToolInput,
  type LocalWriteToolInput,
} from './defs.js';
export { expandHomePath } from './paths.js';
export { CoreReadTool, type CoreReadContext } from './read-tool.js';
export { CoreEditTool, CoreWriteTool } from './write-edit-tools.js';
export {
  CoreBashTool,
  type CoreBashAdapter,
  type CoreBashBackgroundCompletion,
  type CoreBashContext,
  type CoreBashHostTrashRequest,
  type CoreBashManagedForegroundResult,
  type CoreBashToolOptions,
} from './bash-tool.js';
export { runPiBash, type PiBashOptions, type PiBashResult } from './pi-bash.js';
export { CoreGrepTool, type CoreGrepToolOptions, type CoreSearchToolOptions } from './grep-tool.js';
export { CoreGlobTool } from './glob-tool.js';
