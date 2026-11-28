/**
 * Host-neutral tool-catalog policy: canonical builtin ceilings, the
 * model-capability gate, the permission execution plan stamped on a tool
 * context and the trusted coordinator's tool definitions. Every module behind this entry is pure; the closure test in
 * test/neutral-subpaths keeps it that way.
 */
export {
  filterCanonicalNativeToolCeiling,
  isCanonicalBuiltinTurn,
} from '../desktop/canonical-tool-policy.js';
export {
  withPermissionExecutionPlan,
  withPermissionWriteTarget,
} from '../desktop/permission-execution.js';
export { getSuppressedToolNamesForModelCapabilities } from './model-capability-suppression.js';

