/**
 * Host-neutral PTC (run_code) surface: result projection, completeness
 * classification and the mavis_* child vocabulary. Every module behind this
 * entry is pure (no Node IO, no process state); the closure test in
 * test/neutral-subpaths keeps it that way. The files stay under desktop/
 * because Desktop tools import them by relative path.
 */
export {
  classifyDesktopPtcTruncation,
  projectDesktopPtcToolResult,
  sanitizePtcChildExecutionDetailsForSafety,
  sanitizePtcExecutionDetailsForSafety,
  type DesktopPtcTruncationVerdict,
} from '../desktop/ptc-result-projection.js';
export {
  createPtcMavisTools,
  PTC_MAVIS_RUN_CODE_NOTE,
  readPtcMavisChildTarget,
} from '../desktop/local-mavis-ptc.js';
export {
  isPtcMavisChildToolName,
  isPtcMavisDirectCommand,
  ptcMavisChildToolName,
  ptcMavisRunCodeCall,
} from '../desktop/local-mavis-commands.js';
export { PTC_CHILD_FULL_OUTPUT_MAX_BYTES } from '../desktop/output-limit.js';
export { normalizeMavisCommand } from '../shared/mavis-operation-classifier.js';
/**
 * A Host with its own mavis split builds each run_code tool with
 * createPtcMavisChildTool, which registers the mavis call run_code runs it as.
 * Without that binding the executor cannot route the child, so the original
 * mavis never reaches the child catalog.
 */
export { createPtcMavisChildTool } from '../shared/ptc-mavis-child.js';
