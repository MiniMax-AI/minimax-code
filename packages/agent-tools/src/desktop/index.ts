import { toRuntimeTool } from '@mavis/agent-core/tools';
import type { BashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';

import { LocalAskUserTool } from './local-ask-user.js';
import { LocalFeatureEnableTool } from './local-feature-enable.js';
import { LocalBashTool, LocalEditTool, LocalReadTool, LocalWriteTool } from './local-pi-tools.js';
import type { LocalHostTrashRuntime } from './host-trash-executor.js';
import { LocalGlobTool } from './local-glob.js';
import { LocalGrepTool } from './local-grep.js';
import { LocalSkillTool } from './local-skill.js';
import { LocalMavisTool } from './local-mavis.js';
import { LocalMemoryTool } from './local-memory.js';
import { LocalCodeReviewTool } from './local-code-review.js';
import {
  LocalTaskOutputTool,
  LocalTaskQueryTool,
  LocalTaskStopTool,
} from './local-task-control.js';
import { LocalTaskTool } from './local-task.js';
import { LocalTaskAppendTool } from './local-task-append.js';
import { LocalTodoWriteTool } from './local-todowrite.js';
import { LocalWebFetchTool } from './local-webfetch.js';
import { LocalWebSearchTool } from './local-web-search.js';
import { LocalWebsiteDeployTool } from './local-website-deploy.js';
import type {
  LocalAskUserAdapter,
  LocalBashAdapter,
  LocalRuntimeTool,
  LocalSkillReader,
  LocalTaskAdapter,
  LocalTaskAppendAdapter,
  LocalTaskControlAdapter,
  LocalTodoEventSink,
  LocalWebFetchAdapter,
  LocalWebSearchAdapter,
  LocalWebsiteDeployAdapter,
  LocalMemoryAdapter,
  LocalCodeReviewAdapter,
  LocalMavisAgentAdapter,
  LocalMavisCronAdapter,
  LocalMavisMcpAdapter,
  LocalMavisSessionAdapter,
  LocalSandboxBashOperationsFactory,
} from './types.js';

export * from './builtin-defs.js';
export * from './canonical-tool-policy.js';
export * from './local-ask-user.js';
export * from './local-feature-enable.js';
export * from './local-browser.js';
export * from './local-pi-tools.js';
export * from './local-bash-result.js';
export * from './local-bash-timing.js';
export * from './local-bash-input.js';
export * from './local-bash-contract.js';
export { executeLocalHostTrashIfRequested } from './host-trash-executor.js';
export type { LocalHostTrashRuntime } from './host-trash-executor.js';
export * from './local-glob.js';
export * from './local-grep.js';
export * from './local-rg-runner.js';
export * from './local-skill.js';
export * from './local-mavis.js';
export * from './local-mavis-commands.js';
export * from './local-mavis-cron-adapter.js';
export * from './local-memory.js';
export * from './local-code-review.js';
export * from './local-task-control.js';
export * from './local-task.js';
export * from './local-task-append.js';
export * from './task-verification.js';
export * from './local-todowrite.js';
export * from './local-webfetch.js';
export * from './local-web-search.js';
export * from './local-website-deploy.js';
export * from './matrix-client.js';
export * from './managed-routing.js';
export * from './matrix-env.js';
export * from './matrix-media-client.js';
export * from './matrix-mcp-server.js';
export * from './matrix-tools.js';
export * from './types.js';
export * from './subagent-roles.js';
export * from '../shared/web-search.js';
export {
  DEFAULT_BROAD_FILE_EXCLUDES,
  DEFAULT_SCAN_DIRECTORY_NAMES,
  isDefaultBroadFileExcluded,
  isDefaultScanNoisePath,
} from '../shared/rg-scan-policy.js';
export { isSensitiveSearchPath } from './local-sensitive.js';

export interface LocalToolRegistryDeps {
  workspaceRoot: string;
  skillReader?: LocalSkillReader;
  todoEventSink?: LocalTodoEventSink;
  askUserAdapter?: LocalAskUserAdapter;
  bashAdapter?: LocalBashAdapter;
  sandboxOperationsFactory?: LocalSandboxBashOperationsFactory;
  hostTrashRuntime?: LocalHostTrashRuntime;
  /**
   * Layer B env sanitize policy for bash subprocesses (Layer A boundary strip
   * is always on). REQUIRED so every assembly names its policy explicitly —
   * production passes `resolveAgentBashEnvPolicy(dataDir)` (rm-shim PATH +
   * spawn preflight); tests typically pass `{ mode: 'off' }`. See
   * design/tools-optimize/bash-tool-optimization.md.
   */
  bashEnvPolicy: BashEnvPolicy;
  webFetchAdapter?: LocalWebFetchAdapter;
  webSearchAdapter?: LocalWebSearchAdapter;
  taskAdapter?: LocalTaskAdapter;
  taskAppendAdapter?: LocalTaskAppendAdapter;
  taskControlAdapter?: LocalTaskControlAdapter;
  websiteDeployAdapter?: LocalWebsiteDeployAdapter;
  memoryAdapter?: LocalMemoryAdapter;
  codeReviewAdapter?: LocalCodeReviewAdapter;
  mavisAgentAdapter?: LocalMavisAgentAdapter;
  mavisCronAdapter?: LocalMavisCronAdapter;
  mavisMcpAdapter?: LocalMavisMcpAdapter;
  mavisSessionAdapter?: LocalMavisSessionAdapter;
}

export function buildLocalToolRegistry(deps: LocalToolRegistryDeps): Map<string, LocalRuntimeTool> {
  const tools: LocalRuntimeTool[] = [
    toRuntimeTool(new LocalReadTool(deps.workspaceRoot)),
    toRuntimeTool(new LocalWriteTool(deps.workspaceRoot)),
    toRuntimeTool(new LocalEditTool(deps.workspaceRoot)),
    toRuntimeTool(
      new LocalBashTool(
        deps.workspaceRoot,
        deps.bashAdapter,
        deps.bashEnvPolicy,
        deps.hostTrashRuntime,
        deps.sandboxOperationsFactory,
      ),
    ),
    toRuntimeTool(new LocalGrepTool(deps.workspaceRoot)),
    toRuntimeTool(new LocalGlobTool(deps.workspaceRoot)),
    toRuntimeTool(new LocalTodoWriteTool(deps.todoEventSink)),
  ];
  if (deps.skillReader) {
    tools.push(toRuntimeTool(new LocalSkillTool(deps.skillReader)));
  }
  if (deps.memoryAdapter) {
    tools.push(toRuntimeTool(new LocalMemoryTool(deps.memoryAdapter)));
  }
  if (deps.codeReviewAdapter) {
    tools.push(toRuntimeTool(new LocalCodeReviewTool(deps.codeReviewAdapter)));
  }
  if (deps.mavisAgentAdapter) {
    tools.push(
      toRuntimeTool(
        new LocalMavisTool(
          deps.mavisAgentAdapter,
          deps.mavisCronAdapter,
          deps.mavisSessionAdapter,
          deps.mavisMcpAdapter,
        ),
      ),
    );
  }
  if (deps.askUserAdapter) {
    tools.push(toRuntimeTool(new LocalAskUserTool(deps.askUserAdapter)));
    tools.push(toRuntimeTool(new LocalFeatureEnableTool(deps.askUserAdapter)));
  }
  if (deps.webFetchAdapter) {
    tools.push(toRuntimeTool(new LocalWebFetchTool(deps.webFetchAdapter)));
  }
  if (deps.webSearchAdapter) {
    tools.push(toRuntimeTool(new LocalWebSearchTool(deps.webSearchAdapter)));
  }
  if (deps.taskAdapter) {
    tools.push(toRuntimeTool(new LocalTaskTool(deps.taskAdapter)));
  }
  if (deps.taskAppendAdapter) {
    tools.push(toRuntimeTool(new LocalTaskAppendTool(deps.taskAppendAdapter)));
  }
  if (deps.taskControlAdapter) {
    tools.push(
      toRuntimeTool(new LocalTaskQueryTool(deps.taskControlAdapter)),
      toRuntimeTool(new LocalTaskOutputTool(deps.taskControlAdapter)),
      toRuntimeTool(new LocalTaskStopTool(deps.taskControlAdapter)),
    );
  }
  if (deps.websiteDeployAdapter) {
    tools.push(
      toRuntimeTool(new LocalWebsiteDeployTool(deps.websiteDeployAdapter, deps.workspaceRoot)),
    );
  }

  const map = new Map<string, LocalRuntimeTool>();
  for (const tool of tools) {
    if (map.has(tool.def.name)) {
      throw new Error(`buildLocalToolRegistry: duplicate tool name '${tool.def.name}'`);
    }
    map.set(tool.def.name, tool);
  }
  return map;
}

export {
  CloudSessionReader,
  CloudSessionReadError,
  type CloudSessionReaderOptions,
} from './cloud-session-reader.js';
export { DESKTOP_BASH_PREVIEW_BYTES } from './output-limit.js';
