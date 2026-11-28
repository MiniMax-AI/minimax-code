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
 *      LLM gate, while default mode surfaces user confirmation. Writes under
 *      the system temp directory are allowed, as for bash and apply_patch.
 *   3. Otherwise `isPathAllowed` decides; soft sensitive paths return
 *      normal ASK so auto mode can route them through the classifier gate
 *      (handled by PermissionService, not here).
 */

import type { ToolPermissionChecker, ToolCheckResult } from '../engine.js';
import type { ToolPermissionContext } from '../context.js';
import { recordWrite } from '../written-files-registry.js';
import { validateGlobPattern } from './fs-permission.js';
import { evaluatePathCapability, generateSuggestionRules } from './path-capability.js';
import { extractFilePath, toolActionForFsTool, WRITE_TOOLS } from './fs-input.js';

export class FsToolPermissionChecker implements ToolPermissionChecker {
  checkPermissions(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: Record<string, any>,
    context: ToolPermissionContext,
  ): ToolCheckResult | undefined {
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
      extractFilePath(toolName, input) ??
      (toolName === 'grep' || toolName === 'glob' || toolName === 'list'
        ? context.workingDirectory
        : undefined);
    if (!filePath) return undefined;

    const decision = evaluatePathCapability(filePath, toolActionForFsTool(toolName), context, {
      toolName,
      // Same temp-directory write allowance as bash and apply_patch: a scratch
      // file under the system temp directory needs no approval. Deny rules and
      // sensitive names are checked before this fallback, so `<tmp>/.env` or a
      // user-denied temp path still stops.
      allowTempWrite: WRITE_TOOLS.has(toolName),
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
