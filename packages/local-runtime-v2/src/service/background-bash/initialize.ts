import type {
  LocalBashEnvPolicySource,
  LocalSandboxBashOperationsFactory,
} from '@mavis/agent-tools/desktop';

import { createLocalBackgroundBashExecutor } from './executor.js';

export function initializeLocalBackgroundBashExecutor(
  operationsFactory: LocalSandboxBashOperationsFactory,
  envPolicy: LocalBashEnvPolicySource,
) {
  return createLocalBackgroundBashExecutor(operationsFactory, envPolicy);
}
