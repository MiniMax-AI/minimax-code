import type { V1ServiceCompatibility } from '../../compat/v1/runtime.js';
import { createProcessLocalApplication } from '../index.js';
import { createProcessLocalMiniAppApplication } from './process-local-miniapp-application.js';
import {
  createSandboxModeCapability,
  type SandboxModeCapabilityService,
} from './sandbox-mode-capability.js';

type ProcessLocalApplicationOptions = Parameters<typeof createProcessLocalApplication>[0];
type ProcessLocalMiniAppArgs = Parameters<typeof createProcessLocalMiniAppApplication>;

/**
 * Wires the process-local Application facade over owners the runtime has already
 * initialized, keeping that wiring out of the services composition root.
 */
export function composeProcessLocalApplication(input: {
  readonly eventBus: ProcessLocalApplicationOptions['eventBus'];
  readonly usageCommits: ProcessLocalApplicationOptions['usageCommits'];
  readonly compatibility: Pick<V1ServiceCompatibility, 'skills' | 'peripherals'>;
  readonly listRuntimeSkills: ProcessLocalApplicationOptions['skills']['listRuntimeSkills'];
  readonly plugins: ProcessLocalApplicationOptions['plugins'];
  readonly pluginControl: ProcessLocalMiniAppArgs[0];
  readonly miniApp: ProcessLocalMiniAppArgs[1];
  readonly planEntryEnabled: () => boolean;
  readonly sessionReports?: ProcessLocalApplicationOptions['sessionReports'];
  readonly instructions?: ProcessLocalApplicationOptions['instructions'];
  readonly mcp: ProcessLocalApplicationOptions['peripherals']['mcp'];
  readonly modelProvider: ProcessLocalApplicationOptions['modelProvider'];
  readonly sandbox: SandboxModeCapabilityService;
}): ReturnType<typeof createProcessLocalApplication> {
  return createProcessLocalApplication({
    eventBus: input.eventBus,
    usageCommits: input.usageCommits,
    skills: {
      listSkills: (request) => input.compatibility.skills.listSkills(request),
      listRuntimeSkills: (request) => input.listRuntimeSkills(request),
    },
    plugins: input.plugins,
    miniApps: createProcessLocalMiniAppApplication(input.pluginControl, input.miniApp),
    workspace: { ...input.compatibility.peripherals.workspace },
    plan: { isEntryEnabled: input.planEntryEnabled },
    ...(input.sessionReports ? { sessionReports: input.sessionReports } : {}),
    instructions: input.instructions,
    peripherals: {
      ...input.compatibility.peripherals,
      mcp: input.mcp,
      configuration: {
        ...input.compatibility.peripherals.configuration,
        ...createSandboxModeCapability(input.sandbox),
      },
    },
    modelProvider: input.modelProvider,
  });
}
