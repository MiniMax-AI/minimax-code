import {
  HOOK_MODULES_INVALID_FIX,
  PLUGIN_HOOK_EVENTS,
  type PluginHookCommandHandler,
  type PluginHookDiagnostic,
  type PluginHookEventName,
  type PluginHookModulesDeclaration,
  type PluginHookSet,
  type PluginHookSourceFormat,
} from './contracts.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_EXECUTABLE_HANDLERS = 64;
const MAX_MATCHER_LENGTH = 256;
const EVENT_NAMES = new Set<string>(PLUGIN_HOOK_EVENTS);
/** Top-level hooks document keys that are not Hook events. */
const NON_EVENT_KEYS = new Set(['modules', 'description']);
const MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);

export function parsePluginHookDocuments(input: {
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly sourceFormat: PluginHookSourceFormat;
  readonly documents: readonly {
    readonly sourcePath: string;
    readonly value: unknown;
  }[];
}): PluginHookSet {
  const handlers: PluginHookCommandHandler[] = [];
  const diagnostics: PluginHookDiagnostic[] = [];
  const modules: PluginHookModulesDeclaration[] = [];
  let declarationOrder = 0;
  for (const document of input.documents) {
    const declaration = readModulesDeclaration(document);
    if (declaration) {
      modules.push(declaration);
      if (!declaration.modulePath && input.sourceFormat === 'MINIMAX') {
        diagnostics.push({
          ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_MODULES_INVALID'),
          fix: HOOK_MODULES_INVALID_FIX,
        });
      }
    }
    const hooks = readHooksEnvelope(document.value);
    if (!hooks) {
      diagnostics.push(
        baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
      );
      continue;
    }
    for (const [rawEvent, rawGroups] of Object.entries(hooks)) {
      if (!EVENT_NAMES.has(rawEvent)) {
        diagnostics.push(
          baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_EVENT_UNSUPPORTED'),
        );
        continue;
      }
      const event = rawEvent as PluginHookEventName;
      const groups = Array.isArray(rawGroups) ? rawGroups : [];
      if (!Array.isArray(rawGroups)) {
        diagnostics.push({
          ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
          event,
        });
        continue;
      }
      for (const group of groups) {
        const rawHandlers = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : [];
        if (!isRecord(group) || !Array.isArray(group.hooks)) {
          diagnostics.push({
            ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
            event,
          });
          continue;
        }
        const rawMatcher = group.matcher;
        if (
          rawMatcher !== undefined &&
          (typeof rawMatcher !== 'string' ||
            (!rawMatcher.trim() && input.sourceFormat === 'MINIMAX'))
        ) {
          diagnostics.push({
            ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
            event,
          });
          continue;
        }
        const matcher =
          typeof rawMatcher === 'string' && rawMatcher.trim() ? rawMatcher : undefined;
        if (!isValidMatcher(event, matcher, input.sourceFormat)) {
          diagnostics.push({
            ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
            event,
          });
          continue;
        }
        for (const rawHandler of rawHandlers) {
          const currentOrder = declarationOrder;
          declarationOrder += 1;
          if (!isRecord(rawHandler)) {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          if (rawHandler.async !== undefined && typeof rawHandler.async !== 'boolean') {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          if (rawHandler.asyncRewake !== undefined && typeof rawHandler.asyncRewake !== 'boolean') {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          if (rawHandler.asyncRewake !== undefined && input.sourceFormat !== 'CLAUDE') {
            diagnostics.push(
              diagnostic(
                input,
                document.sourcePath,
                event,
                currentOrder,
                'HOOK_HANDLER_UNSUPPORTED',
              ),
            );
            continue;
          }
          if (rawHandler.args !== undefined && !Array.isArray(rawHandler.args)) {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          const args = rawHandler.args;
          if (Array.isArray(args) && args.some((item) => typeof item !== 'string')) {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          if (args !== undefined && input.sourceFormat !== 'CLAUDE') {
            diagnostics.push(
              diagnostic(
                input,
                document.sourcePath,
                event,
                currentOrder,
                'HOOK_HANDLER_UNSUPPORTED',
              ),
            );
            continue;
          }
          const shell = rawHandler.shell;
          if (
            shell !== undefined &&
            (input.sourceFormat !== 'CLAUDE' || (shell !== 'bash' && shell !== 'powershell'))
          ) {
            diagnostics.push(
              diagnostic(
                input,
                document.sourcePath,
                event,
                currentOrder,
                input.sourceFormat === 'CLAUDE'
                  ? 'HOOK_SCHEMA_INVALID'
                  : 'HOOK_HANDLER_UNSUPPORTED',
              ),
            );
            continue;
          }
          const condition = rawHandler.if;
          if (condition !== undefined && typeof condition !== 'string') {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          if (
            typeof condition === 'string' &&
            (input.sourceFormat !== 'CLAUDE' || !isValidToolCondition(event, condition))
          ) {
            diagnostics.push(
              diagnostic(
                input,
                document.sourcePath,
                event,
                currentOrder,
                'HOOK_HANDLER_UNSUPPORTED',
              ),
            );
            continue;
          }
          if (typeof rawHandler.type !== 'string') {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          const type = rawHandler.type;
          if (type !== 'command' || rawHandler.async === true || rawHandler.asyncRewake === true) {
            diagnostics.push(
              diagnostic(
                input,
                document.sourcePath,
                event,
                currentOrder,
                'HOOK_HANDLER_UNSUPPORTED',
              ),
            );
            continue;
          }
          const command = commandValue(rawHandler);
          const timeoutMs = timeoutValue(rawHandler.timeout);
          if (
            rawHandler.additionalContextLimit !== undefined &&
            input.sourceFormat === 'CODEX' &&
            supportsAdditionalContextLimit(event) &&
            !isValidAdditionalContextLimit(rawHandler.additionalContextLimit)
          ) {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          const additionalContextLimit = readAdditionalContextLimit(
            rawHandler.additionalContextLimit,
            event,
            input.sourceFormat,
          );
          if (!command || timeoutMs === undefined) {
            diagnostics.push(
              diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'),
            );
            continue;
          }
          if (handlers.length >= MAX_EXECUTABLE_HANDLERS) {
            diagnostics.push(
              diagnostic(
                input,
                document.sourcePath,
                event,
                currentOrder,
                'HOOK_HANDLER_LIMIT_EXCEEDED',
              ),
            );
            continue;
          }
          handlers.push({
            kind: 'command',
            sourceFormat: input.sourceFormat,
            pluginName: input.pluginName,
            pluginRoot: input.pluginRoot,
            sourcePath: document.sourcePath,
            event,
            ...(matcher?.trim() ? { matcher: matcher.trim() } : {}),
            command,
            ...(Array.isArray(args) ? { args: args as string[] } : {}),
            ...(args === undefined && (shell === 'bash' || shell === 'powershell')
              ? { shell }
              : {}),
            ...(typeof condition === 'string' ? { condition: condition.trim() } : {}),
            timeoutMs,
            ...(additionalContextLimit !== undefined ? { additionalContextLimit } : {}),
            declarationOrder: currentOrder,
          });
        }
      }
    }
  }
  return { handlers, diagnostics, modules };
}

function readModulesDeclaration(document: {
  readonly sourcePath: string;
  readonly value: unknown;
}): PluginHookModulesDeclaration | undefined {
  if (!isRecord(document.value) || !('modules' in document.value)) return undefined;
  const value = document.value.modules;
  const modulePath =
    Array.isArray(value) && value.length === 1 && isModulePath(value[0]) ? value[0] : undefined;
  return { sourcePath: document.sourcePath, ...(modulePath ? { modulePath } : {}) };
}

function isModulePath(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || !value) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  // Absolute, drive-letter and scheme (`node:`, `data:`) paths; the SDK schema shares this rule.
  if (value.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
  const extensionStart = value.lastIndexOf('.');
  const fileStart = value.lastIndexOf('/') + 1;
  return extensionStart > fileStart && MODULE_EXTENSIONS.has(value.slice(extensionStart));
}

function readAdditionalContextLimit(
  value: unknown,
  event: PluginHookEventName,
  sourceFormat: PluginHookSourceFormat,
): number | undefined {
  if (value === undefined || sourceFormat !== 'CODEX') return undefined;
  if (!supportsAdditionalContextLimit(event)) return undefined;
  return isValidAdditionalContextLimit(value) ? value : undefined;
}

function supportsAdditionalContextLimit(event: PluginHookEventName): boolean {
  return (
    event === 'PreToolUse' ||
    event === 'PostToolUse' ||
    event === 'SessionStart' ||
    event === 'UserPromptSubmit' ||
    event === 'SubagentStart'
  );
}

function isValidAdditionalContextLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidMatcher(
  event: PluginHookEventName,
  matcher: string | undefined,
  sourceFormat: PluginHookSourceFormat,
): boolean {
  if (matcher === undefined) return true;
  if (matcher.length > MAX_MATCHER_LENGTH) return false;
  if (matcher.trim() === '*' || event === 'UserPromptSubmit' || event === 'Stop') return true;
  if (sourceFormat === 'CODEX') {
    if (/^[A-Za-z0-9_|]+$/u.test(matcher)) return true;
  } else {
    const alternatives = matcher.split(/[|,]/u).map((part) => part.trim());
    if (alternatives.every((part) => /^[A-Za-z0-9_.:/-]+$/u.test(part))) return true;
  }
  return isSafePluginHookMatcher(matcher);
}

function isValidToolCondition(event: PluginHookEventName, condition: string): boolean {
  if (event !== 'PreToolUse' && event !== 'PermissionRequest' && event !== 'PostToolUse')
    return false;
  const trimmed = condition.trim();
  if (!trimmed || trimmed.length > MAX_MATCHER_LENGTH) return false;
  const match = /^([A-Za-z0-9_.:/-]+)\(([^\r\n()]*)\)$/u.exec(trimmed);
  return Boolean(match?.[1] && match[2] !== undefined);
}

export function isSafePluginHookMatcher(pattern: string): boolean {
  if (!pattern || pattern.length > MAX_MATCHER_LENGTH || hasUnsupportedGroupExtension(pattern)) {
    return false;
  }
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      const width = safeEscapeWidth(pattern, index);
      if (width === 0) return false;
      index += width - 1;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === ')' && /[*+?{]/u.test(pattern[index + 1] ?? '')) return false;
  }
  if (escaped) return false;
  if (hasExcessiveRepeatedQuantifiedAtom(pattern)) return false;
  try {
    RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

/**
 * Compatible's JavaScript regexp engine and Codex's Rust regexp engine both support
 * non-capturing groups. Their look-around and named-group support differs, so
 * keep the portable subset (`(?:...)`) and reject every other `(?...)` form.
 */
function hasUnsupportedGroupExtension(pattern: string): boolean {
  for (
    let offset = pattern.indexOf('(?');
    offset >= 0;
    offset = pattern.indexOf('(?', offset + 2)
  ) {
    if (pattern[offset + 2] !== ':') return true;
  }
  return false;
}

function hasExcessiveRepeatedQuantifiedAtom(pattern: string): boolean {
  const counts = new Map<string, number>();
  for (const match of pattern.matchAll(/((?:\\.|[A-Za-z0-9_.-]))(?:[*+?]|\{\d+(?:,\d*)?\})/gu)) {
    const atom = match[1];
    if (!atom) continue;
    const count = (counts.get(atom) ?? 0) + 1;
    if (count >= 4) return true;
    counts.set(atom, count);
  }
  return false;
}

function safeEscapeWidth(pattern: string, index: number): number {
  const char = pattern[index];
  if (!char || /[1-9kKpPAZGz]/u.test(char)) return 0;
  if (char === 'x') return /^[0-9A-Fa-f]{2}$/u.test(pattern.slice(index + 1, index + 3)) ? 3 : 0;
  if (char === 'u') return /^[0-9A-Fa-f]{4}$/u.test(pattern.slice(index + 1, index + 5)) ? 5 : 0;
  return /[dDsSwWbBfnrtv0\\.^$*+?()[\]{}|/-]/u.test(char) ? 1 : 0;
}

function readHooksEnvelope(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.hooks)) return value.hooks;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !NON_EVENT_KEYS.has(key)));
}

function commandValue(value: Record<string, unknown>): string | undefined {
  const command =
    process.platform === 'win32'
      ? (value.commandWindows ?? value.command_windows ?? value.command)
      : value.command;
  return typeof command === 'string' && command.trim() ? command.trim() : undefined;
}

function timeoutValue(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
    return undefined;
  }
  return Math.min(value * 1_000, MAX_TIMEOUT_MS);
}

function baseDiagnostic(
  pluginName: string,
  sourcePath: string,
  code: string,
): PluginHookDiagnostic {
  return { pluginName, sourcePath, code };
}

function diagnostic(
  input: { readonly pluginName: string },
  sourcePath: string,
  event: PluginHookEventName,
  declarationOrder: number,
  code: string,
): PluginHookDiagnostic {
  return { pluginName: input.pluginName, sourcePath, event, declarationOrder, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
