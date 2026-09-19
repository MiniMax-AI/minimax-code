/**
 * FsToolPermissionChecker — adapter bridging isPathAllowed() and
 * validateGlobPattern() to the {@link ToolPermissionChecker} interface
 * consumed by {@link PermissionEngine}.
 *
 * Registered for: edit, write, append, read, glob, grep, list.
 *
 * Semantics:
 *
 *   1. Sensitive FS paths run BEFORE the isPathAllowed check:
 *      system secrets, credentials, and private keys flow through the LLM gate
 *      in auto/bypass modes and fall back to user ask when not allowed.
 *   2. Workspace boundary asks delegate to the mode router: auto may use the
 *      LLM gate, while default mode surfaces user confirmation.
 *   3. Otherwise `isPathAllowed` decides; soft sensitive paths return
 *      normal ASK so auto mode can route them through the classifier gate
 *      (handled by PermissionService, not here).
 */

import type { ToolPermissionChecker, ToolCheckResult } from '../engine.js';
import type { ToolPermissionContext } from '../context.js';
import { logger, backgroundCtx } from '../host-utils.js';
import { recordWrite } from '../written-files-registry.js';
import { validateGlobPattern } from './fs-permission.js';
import { evaluatePathCapability, generateSuggestionRules } from './path-capability.js';

const WRITE_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'append']);

export class FsToolPermissionChecker implements ToolPermissionChecker {
  checkPermissions(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: Record<string, any>,
    context: ToolPermissionContext,
  ): ToolCheckResult | undefined {
    logger.info(
      backgroundCtx(),
      `FsToolPermissionChecker checkPermissions called, toolName=${toolName}, input=${JSON.stringify(input)}, context=${JSON.stringify(context)}`,
    );

    // Glob tool: validate pattern first
    if (toolName === 'glob') {
      const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
      if (pattern) {
        const validation = validateGlobPattern(pattern);
        if (!validation.valid) {
          return {
            behavior: 'deny',
            reason: { type: 'pathValidation', error: validation.error! },
          };
        }
      }
    }

    // Extract file path from input
    const filePath =
      extractFilePath(input) ??
      (toolName === 'grep' || toolName === 'glob' || toolName === 'list'
        ? context.workingDirectory
        : undefined);
    if (!filePath) return undefined;

    const decision = evaluatePathCapability(filePath, toolActionForFsTool(toolName), context, {
      toolName,
    });

    if (decision.behavior === 'allow') {
      this.maybeRecordWrite(toolName, filePath, context);
      return decision;
    }
    return decision;
  }

  /**
   * Generate directory-level rule content suggestions for a file path.
   *
   * Instead of suggesting an exact file path (e.g. `/Users/me/Downloads/hello.html`),
   * this produces the parent directory with a `/**` glob suffix
   * (e.g. `/Users/me/Downloads/**`), giving the user a broader, more practical rule.
   *
   * Reference: restored-src `generateSuggestions` in filesystem.ts
   */
  generateSuggestionRules(filePath: string): string[] {
    return generateSuggestionRules(filePath);
  }

  /**
   * Record write tool allow decisions into the session-scoped written-files
   * registry. The registry is consulted by the bash SOFT remote-execution
   * pre-scan to whitelist `bash <local-script>` invocations against scripts
   * the agent just produced (see `written-files-registry.ts`).
   *
   * Read-only tools (read/glob/grep/list) intentionally do NOT record —
   * reading a file does not produce a runnable script. Allow paths from
   * any source (workingDirectory / tempDirectory / sandbox / rule) all
   * record, because the user's intent ("this file is mine") is the same.
   */
  private maybeRecordWrite(
    toolName: string,
    filePath: string,
    context: ToolPermissionContext,
  ): void {
    if (!WRITE_TOOLS.has(toolName)) return;
    const sessionId = context.sessionId;
    if (!sessionId) return;
    recordWrite(sessionId, filePath);
  }
}

function toolActionForFsTool(toolName: string): 'read' | 'write' {
  return WRITE_TOOLS.has(toolName) ? 'write' : 'read';
}

/** Extract the primary file path from a tool's input object. */
function extractFilePath(input: Record<string, unknown>): string | undefined {
  if (typeof input.file_path === 'string' && input.file_path) return input.file_path;
  if (typeof input.filePath === 'string' && input.filePath) return input.filePath;
  if (typeof input.path === 'string' && input.path) return input.path;
  // A search pattern is not a filesystem path. Directory tools default to cwd.
  return undefined;
}
