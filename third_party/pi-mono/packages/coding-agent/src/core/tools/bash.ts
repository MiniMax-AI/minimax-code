import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess, waitForChildProcessExit } from "../../utils/child-process.ts";
import {
	armParentDeathGuard,
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ProcessTreeTermination,
	terminateProcessTreeGracefully,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { OutputAccumulator, type OutputAccumulatorOptions } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const bashSchema = Type.Object({
	command: Type.String({
		description:
			"Command to execute in the current shell. On Windows the default shell is PowerShell; use PowerShell syntax unless the configured shell is bash.",
	}),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	execution?: BashExecutionOutcome;
	timing?: { commandTimerStartedAt: number; commandDeadlineAt: number };
	output?: {
		rawBytes: number;
		persistence: "inline" | "complete" | "incomplete" | "host";
		persistenceError?: string;
	};
	/** Exact process facts retained for consumers that need split streams. */
	processOutput?: BashProcessOutput;
}

export interface BashExecutionOutcome {
	status: "succeeded" | "failed" | "canceled";
	reason: "exited" | "signaled" | "command_timeout" | "canceled" | "spawn_failed" | "unknown";
	exitCode: number | null;
	signal?: NodeJS.Signals;
	errorCode?: string;
	cancellationReason?: string;
	/** Failure explanation without duplicating captured command output. */
	message?: string;
}

/** Carries the same output and execution facts as a successful Bash result. */
export class BashExecutionError extends Error {
	readonly details: BashToolDetails & { execution: BashExecutionOutcome };
	readonly code?: string;

	constructor(message: string, details: BashToolDetails & { execution: BashExecutionOutcome }, options?: ErrorOptions) {
		super(message, options);
		this.name = "BashExecutionError";
		this.details = details;
		this.code = details.execution.errorCode;
	}
}

export interface BashProcessOutput {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	interrupted: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	rawOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/** Whether exec invokes the split stdout/stderr callbacks exactly. */
	readonly separatesOutputStreams?: boolean;
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code and, when available, terminating signal
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer, stream?: "stdout" | "stderr") => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			/** Best-effort process facts. A launcher spawn does not prove the user command started. */
			onProcessEvent?: (event: {
				type: "spawned" | "spawn_failed" | "timeout" | "command_dispatched" | "timer_started";
				atMs?: number;
				processRole: "shell" | "guardian_launcher";
			}) => void;
		},
	) => Promise<{ exitCode: number | null; signal?: NodeJS.Signals | null }>;
}

const GUARDED_SHELL_LAUNCHER_SOURCE = String.raw`
import { spawn } from "node:child_process";

let serialized = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { serialized += chunk; });
process.stdin.once("end", () => {
  if (!serialized) {
    process.exitCode = 125;
    return;
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch (error) {
    process.stderr.write("Failed to decode guarded shell command: " + String(error) + "\n");
    process.exitCode = 125;
    return;
  }
  let settled = false;
  const child = spawn(payload.shell, [...payload.args, payload.command], {
    stdio: [typeof payload.stdin === "string" ? "pipe" : "ignore", "inherit", "inherit"],
    windowsHide: true,
    env: payload.env,
  });
  child.stdin?.on("error", () => undefined);
  if (child.stdin && typeof payload.stdin === "string") child.stdin.end(payload.stdin);
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    process.stderr.write("Failed to launch guarded shell: " + String(error) + "\n");
    process.exitCode = 126;
  });
  child.once("exit", (code) => {
    if (settled) return;
    settled = true;
    process.exitCode = code ?? 1;
  });
});
process.stdin.resume();
`;

const GUARDED_UNIX_SHELL_LAUNCHER_SOURCE = String.raw`
IFS= read -r __mavis_guardian_ready || exit 125
exec "$@" </dev/null
`;

// Resolve the gate independently from the command environment. Using a bare
// `sh` here would let a missing or attacker-controlled PATH break or replace
// the pre-command guardian gate before registration completes.
const GUARDED_UNIX_SHELL_LAUNCHER = process.platform === "android" ? "/system/bin/sh" : "/bin/sh";

type WindowsPowerShellLanguageMode = "FullLanguage" | "ConstrainedLanguage";

const windowsPowerShellLanguageModeByShell = new Map<
	string,
	Promise<WindowsPowerShellLanguageMode | undefined>
>();

async function detectWindowsPowerShellLanguageMode(
	shell: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<WindowsPowerShellLanguageMode | undefined> {
	const child = spawn(shell, [...args, "$ExecutionContext.SessionState.LanguageMode"], {
		cwd,
		detached: false,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdout = "";
	child.stdout?.on("data", (data: Buffer) => {
		if (stdout.length < 128) stdout += data.toString("utf8");
	});
	const timeout = setTimeout(() => child.kill(), 5000);
	timeout.unref?.();
	try {
		const exitCode = await waitForChildProcess(child);
		if (exitCode !== 0) return undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
	const mode = stdout.trim();
	return mode === "FullLanguage" || mode === "ConstrainedLanguage" ? mode : undefined;
}

async function getWindowsPowerShellLanguageMode(
	shell: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<WindowsPowerShellLanguageMode | undefined> {
	let pending = windowsPowerShellLanguageModeByShell.get(shell);
	if (!pending) {
		pending = detectWindowsPowerShellLanguageMode(shell, args, cwd, env);
		windowsPowerShellLanguageModeByShell.set(shell, pending);
	}
	const mode = await pending;
	if (mode === undefined && windowsPowerShellLanguageModeByShell.get(shell) === pending) {
		windowsPowerShellLanguageModeByShell.delete(shell);
	}
	return mode;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 *
 * On Windows, if PowerShell is detected, UTF-8 encoding is automatically
 * injected for Windows PowerShell 5.1 (pwsh 7+ is natively UTF-8).
 */
export function createLocalBashOperations(options?: {
	shellPath?: string;
	parentDeathGuard?: boolean;
}): BashOperations {
	return {
		separatesOutputStreams: true,
		exec: async (command, cwd, { onData, signal, timeout, env, onProcessEvent }) => {
			const observe = (type: "spawned" | "spawn_failed" | "timeout" | "command_dispatched" | "timer_started", atMs?: number) => {
				try {
					onProcessEvent?.({ type, processRole: options?.parentDeathGuard ? "guardian_launcher" : "shell", ...(atMs === undefined ? {} : { atMs }) });
				} catch {
					// Observers never control execution.
				}
			};
			const shellConfig = getShellConfig(options?.shellPath);
			const { shell, args } = shellConfig;
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute commands.`);
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}

			const shellEnv = { ...(env ?? getShellEnv()) };
			// For Windows PowerShell 5.1, inject UTF-8 encoding setup in FullLanguage.
			// ConstrainedLanguage blocks the .NET APIs used by that wrapper, so carry
			// the UTF-16 command through the process environment and evaluate it in the
			// already-constrained session instead.
			let effectiveCommand = command;
			let stdinCommand: string | undefined;
			if (shellConfig.type === "powershell") {
				const languageMode = await getWindowsPowerShellLanguageMode(shell, args, cwd, shellEnv);
				if (signal?.aborted) throw new Error("aborted");
				if (languageMode === "ConstrainedLanguage") {
					const transport = wrapConstrainedWindowsPowerShellCommand();
					effectiveCommand = transport.launcher;
					shellEnv[transport.environmentVariable] = command;
				} else {
					effectiveCommand = wrapWindowsPowerShellStdinCommand();
					stdinCommand = command;
				}
			}
			const guardRequired = options?.parentDeathGuard === true;
			if (signal?.aborted) throw new Error("aborted");
			const child = guardRequired
				? process.platform === "win32"
					? spawn(process.execPath, ["--input-type=module", "--eval", GUARDED_SHELL_LAUNCHER_SOURCE], {
							cwd,
							detached: false,
							env: {
								...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
								...(process.env.windir ? { windir: process.env.windir } : {}),
								...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
							},
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
						})
					: spawn(
							GUARDED_UNIX_SHELL_LAUNCHER,
							[
								"-c",
								GUARDED_UNIX_SHELL_LAUNCHER_SOURCE,
								"mavis-guarded-shell",
								shell,
								...args,
								effectiveCommand,
							],
							{
								cwd,
								detached: true,
								env: shellEnv,
								stdio: ["pipe", "pipe", "pipe"],
								windowsHide: true,
							},
						)
				: spawn(shell, [...args, effectiveCommand], {
						cwd,
						detached: process.platform !== "win32",
						env: shellEnv,
						stdio: [stdinCommand !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					});
			child.once("spawn", () => observe("spawned"));
			child.once("error", () => observe("spawn_failed"));
			if (child.pid) trackDetachedChildPid(child.pid);
			const parentDeathGuard = options?.parentDeathGuard && child.pid ? armParentDeathGuard(child.pid) : undefined;
			// Attach streams and spawn/exit listeners before awaiting the guardian
			// ACK. The guarded child is only a launcher at this point: it cannot run
			// the user command until the registered parent writes the payload.
			child.stdout?.on("data", (data: Buffer) => onData(data, "stdout"));
			child.stderr?.on("data", (data: Buffer) => onData(data, "stderr"));
			child.stdin?.on("error", () => undefined);
			if (!guardRequired && stdinCommand !== undefined) child.stdin?.end(stdinCommand);
			const childCompletion = waitForChildProcessExit(child);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			// Stop/timeout send SIGTERM to the process group first so shell
			// `trap ... TERM` cleanup can run, then escalate to SIGKILL after a
			// grace window. `killEscalation` cancels the pending escalation once
			// the process exits; re-arming (timeout then abort) replaces the
			// previous timer instead of leaking it.
			let killEscalation: ProcessTreeTermination | undefined;
			const scheduleGracefulKill = () => {
				if (!child.pid) return;
				killEscalation?.();
				killEscalation = terminateProcessTreeGracefully(child.pid);
			};
			const onAbort = () => {
				scheduleGracefulKill();
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			try {
				if (guardRequired && !parentDeathGuard) {
					child.stdin?.destroy();
					if (child.pid) killProcessTree(child.pid);
					await childCompletion.catch(() => undefined);
					throw new Error("Failed to start parent-death guardian");
				}
				try {
					await parentDeathGuard?.ready;
				} catch (error) {
					child.stdin?.destroy();
					if (child.pid) killProcessTree(child.pid);
					await childCompletion.catch(() => undefined);
					throw error;
				}
				if (guardRequired) {
					if (signal?.aborted) {
						// Closing stdin without a payload retires the launcher without
						// ever spawning the user shell. This makes cancel-vs-ACK atomic
						// from the command's point of view.
						child.stdin?.end();
					} else {
						child.stdin?.end(
							process.platform === "win32"
								? JSON.stringify({ shell, args, command: effectiveCommand, stdin: stdinCommand, env: shellEnv })
								: "ready\n",
						);
						observe("command_dispatched");
					}
				}
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					const timerStartedAt = Date.now();
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						observe("timeout");
						scheduleGracefulKill();
					}, timeout * 1000);
					observe("timer_started", timerStartedAt);
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const termination = await childCompletion;
				if (signal?.aborted) {
					throw new BashExecutionError("aborted", {
						execution: {
							...termination,
							signal: termination.signal ?? undefined,
							status: "canceled",
							reason: "canceled",
							cancellationReason: formatCancellationReason(signal),
							message: "Command aborted",
						},
					});
				}
				if (timedOut) {
					throw new BashExecutionError(`timeout:${timeout}`, {
						execution: {
							...termination,
							signal: termination.signal ?? undefined,
							status: "failed",
							reason: "command_timeout",
							message: `Command timed out after ${timeout} seconds`,
						},
					});
				}
				return termination;
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				// waitForChildProcess resolves when the SHELL exits, which is not
				// the same as the process GROUP being empty: a command may background
				// a SIGTERM-ignoring descendant that outlives the shell. Only cancel
				// the pending SIGKILL escalation once the group is actually gone
				// (kill(-pid, 0) throws ESRCH); otherwise leave the timer armed so the
				// grace-window SIGKILL still reaps surviving descendants. This keeps
				// the PID-reuse guard for the common case while never leaking a
				// runaway process on stop/timeout.
				if (killEscalation) {
					if (process.platform === "win32") {
						// `taskkill /T` may leave a stubborn descendant behind even
						// after the root shell exits. Keep the guardian armed until the
						// scheduled `/F /T` pass has actually been launched.
						await killEscalation.settled;
					} else if (!child.pid) {
						killEscalation();
					} else {
						try {
							process.kill(-child.pid, 0);
							// Group still has members. Do not disarm the guardian during
							// the grace window: if this host is SIGKILLed, it must finish
							// the same cleanup independently.
							await killEscalation.settled;
						} catch {
							// ESRCH: group empty, safe to cancel the pending SIGKILL.
							killEscalation();
						}
					}
				}
				await parentDeathGuard?.disarm();
				if (child.pid) untrackDetachedChildPid(child.pid);
			}
		},
	};
}

function formatCancellationReason(signal?: AbortSignal): string | undefined {
	if (!signal?.aborted) return undefined;
	return signal.reason instanceof Error
		? signal.reason.message
		: typeof signal.reason === "string" ? signal.reason : undefined;
}

function wrapConstrainedWindowsPowerShellCommand(): {
	launcher: string;
	environmentVariable: string;
} {
	const nonce = randomUUID().replaceAll("-", "");
	const environmentVariable = `MAVIS_POWERSHELL_SOURCE_${nonce.toUpperCase()}`;
	const source = `$__mavis${nonce}Source`;
	return {
		environmentVariable,
		// Windows PowerShell 5.1 exits 0 after Invoke-Expression regardless of the
		// native command's exit code; propagate it explicitly or failures report success.
		launcher: `${source} = $env:${environmentVariable}; Remove-Item -LiteralPath 'Env:${environmentVariable}'; Invoke-Expression ${source}; exit $LASTEXITCODE`,
	};
}

function wrapWindowsPowerShellStdinCommand(): string {
	// PowerShell child scopes can read their parent scope. Use a per-execution
	// nonce so the validation transport cannot shadow stable user variable names.
	const prefix = `__mavis${randomUUID().replaceAll("-", "")}`;
	const source = `$${prefix}Source`;
	const tokens = `$${prefix}Tokens`;
	const errors = `$${prefix}Errors`;
	const ast = `$${prefix}Ast`;
	const requirements = `$${prefix}Requirements`;
	const module = `$${prefix}Module`;
	const snapIn = `$${prefix}SnapIn`;
	const loadedSnapIn = `$${prefix}LoadedSnapIn`;
	const identity = `$${prefix}Identity`;
	const principal = `$${prefix}Principal`;
	return [
		"[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"$OutputEncoding = [System.Text.Encoding]::UTF8",
		`${source} = [Console]::In.ReadToEnd()`,
		`${tokens} = $null`,
		`${errors} = $null`,
		`${ast} = [System.Management.Automation.Language.Parser]::ParseInput(${source}, [ref]${tokens}, [ref]${errors})`,
		`if (${errors}.Count) { throw ${errors}[0] }`,
		`${requirements} = ${ast}.ScriptRequirements`,
		`if (${requirements}) {`,
		`  if (${requirements}.RequiredPSVersion -and $PSVersionTable.PSVersion -lt ${requirements}.RequiredPSVersion) { throw ('PowerShell {0} is required' -f ${requirements}.RequiredPSVersion) }`,
		`  if (${requirements}.RequiredPSEditions.Count -and ${requirements}.RequiredPSEditions -notcontains $PSVersionTable.PSEdition) { throw ('PowerShell edition {0} is required' -f (${requirements}.RequiredPSEditions -join ', ')) }`,
		`  if (${requirements}.RequiredApplicationId -and ${requirements}.RequiredApplicationId -ne $ShellId) { throw ('PowerShell ShellId {0} is required' -f ${requirements}.RequiredApplicationId) }`,
		`  foreach (${module} in ${requirements}.RequiredModules) { Import-Module -FullyQualifiedName ${module} -ErrorAction Stop }`,
		`  foreach (${snapIn} in ${requirements}.RequiresPSSnapIns) {`,
		`    ${loadedSnapIn} = Get-PSSnapin -Name ${snapIn}.Name -ErrorAction SilentlyContinue`,
		`    if (-not ${loadedSnapIn}) { Add-PSSnapin -Name ${snapIn}.Name -ErrorAction Stop; ${loadedSnapIn} = Get-PSSnapin -Name ${snapIn}.Name -ErrorAction Stop }`,
		`    if (${snapIn}.Version -and ${loadedSnapIn}.Version -lt ${snapIn}.Version) { throw ('PowerShell snap-in {0} version {1} is required' -f ${snapIn}.Name, ${snapIn}.Version) }`,
		"  }",
		`  if (${requirements}.IsElevationRequired) {`,
		`    ${identity} = [System.Security.Principal.WindowsIdentity]::GetCurrent()`,
		`    ${principal} = New-Object System.Security.Principal.WindowsPrincipal -ArgumentList ${identity}`,
		`    if (-not ${principal}.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required' }`,
		"  }",
		"}",
		`& ([ScriptBlock]::Create(${source}))`,
		// Windows PowerShell 5.1 exits 0 after a scriptblock invocation regardless of
		// the native command's exit code; propagate it explicitly or failures report success.
		"exit $LASTEXITCODE",
	].join("; ");
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Host-specific preview and persistence policy; defaults retain Pi's tail preview. */
	output?: OutputAccumulatorOptions;
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

/** Keep a split stream only while it remains small enough to return exactly. */
class BashProcessStreamCapture {
	private chunks: Buffer[] = [];
	private bytes = 0;
	private completedLines = 0;
	private hasOpenLine = false;
	private truncated = false;

	append(data: Buffer): void {
		if (this.truncated) return;
		this.bytes += data.length;
		for (const byte of data) {
			if (byte === 0x0a) {
				this.completedLines++;
				this.hasOpenLine = false;
			} else {
				this.hasOpenLine = true;
			}
		}
		if (this.bytes > DEFAULT_MAX_BYTES || this.completedLines + (this.hasOpenLine ? 1 : 0) > DEFAULT_MAX_LINES) {
			this.truncated = true;
			this.chunks = [];
			return;
		}
		this.chunks.push(Buffer.from(data));
	}

	snapshot(): { content: string; truncated: boolean } {
		return {
			content: this.truncated ? "" : Buffer.concat(this.chunks).toString("utf-8"),
			truncated: this.truncated,
		};
	}
}

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	// Only probe the local shell when using the built-in local operations.
	// Custom operations (remote/wrapper executors) may not have a matching
	// local shell, so we must not call getShellConfig() unconditionally.
	let isPowerShell = false;
	if (!options?.operations) {
		try {
			const shellConfig = getShellConfig(options?.shellPath);
			isPowerShell = shellConfig.type === "pwsh" || shellConfig.type === "powershell";
		} catch {
			// Shell detection failed (e.g. no shell found) — fall back to bash description.
		}
	}
	const shellDesc = isPowerShell
		? `Execute a PowerShell command in the current working directory. Use PowerShell syntax: $env:VAR for environment variables, Get-ChildItem for ls, Select-String for grep, Get-Content for cat. Do NOT use bash syntax (export, /dev/null, heredocs, sed -i).`
		: `Execute a bash command in the current working directory.`;
	const baseDesc = `${shellDesc} Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`;
	const promptSnip = isPowerShell
		? "Execute PowerShell commands (Get-ChildItem, Select-String, Get-Content, etc.)"
		: "Execute bash commands (ls, grep, find, etc.)";
	return {
		name: "bash",
		label: isPowerShell ? "powershell" : "bash",
		description: baseDesc,
		promptSnippet: promptSnip,
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash", ...options?.output });
			const stdout = new BashProcessStreamCapture();
			const stderr = new BashProcessStreamCapture();
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;
			let timing: BashToolDetails["timing"];

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer, stream?: "stdout" | "stderr") => {
				output.append(data, stream);
				if (stream === "stdout") stdout.append(data);
				if (stream === "stderr") stderr.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const stdoutSnapshot = stdout.snapshot();
				const stderrSnapshot = stderr.snapshot();
				let persistenceError: string | undefined;
				try {
					await output.closeTempFile();
				} catch (error) {
					if (!options?.output) throw error;
					persistenceError = error instanceof Error ? error.message : String(error);
				}
				const snapshot = output.snapshot({ persistIfTruncated: true });
				return { snapshot, stdoutSnapshot, stderrSnapshot, persistenceError };
			};

			const formatOutput = (finished: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const { snapshot } = finished;
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (options?.output?.strategy === "head_tail") {
					return { text, details: { ...(truncation.truncated ? { truncation } : {}), fullOutputPath: snapshot.fullOutputPath } };
				}
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const resultDetails = (
				finished: Awaited<ReturnType<typeof finishOutput>>,
				execution: BashExecutionOutcome,
			): BashToolDetails & { execution: BashExecutionOutcome } => ({
				...formatOutput(finished).details,
				execution,
				...(timing ? { timing } : {}),
				...(options?.output ? { output: {
					rawBytes: finished.snapshot.rawBytes,
					persistence: finished.persistenceError ? "incomplete" as const
						: options.output.persistOutput === false ? "host" as const
							: finished.snapshot.fullOutputPath ? "complete" as const : "inline" as const,
					...(finished.persistenceError ? { persistenceError: finished.persistenceError } : {}),
				} } : {}),
				...(ops.separatesOutputStreams
					? {
							processOutput: {
								stdout: finished.stdoutSnapshot.content,
								stderr: finished.stderrSnapshot.content,
								exitCode: execution.exitCode,
								interrupted: execution.reason === "canceled" || execution.reason === "command_timeout",
								stdoutTruncated: finished.stdoutSnapshot.truncated,
								stderrTruncated: finished.stderrSnapshot.truncated,
								rawOutputPath: finished.snapshot.fullOutputPath,
							},
						}
					: {}),
			});

			try {
				let exitCode: number | null;
				let exitSignal: NodeJS.Signals | null | undefined;
				let spawnFailed = false;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
						onProcessEvent: (event) => {
							if (event.type === "spawn_failed") spawnFailed = true;
							if (event.type === "timer_started" && event.atMs !== undefined && timeout !== undefined) {
								timing = { commandTimerStartedAt: event.atMs, commandDeadlineAt: event.atMs + timeout * 1000 };
							}
						},
					});
					exitCode = result.exitCode;
					exitSignal = result.signal;
				} catch (err) {
					const finished = await finishOutput();
					const { text } = formatOutput(finished, "");
					let execution: BashExecutionOutcome;
					if (err instanceof BashExecutionError) execution = err.details.execution;
					else {
						const message = err instanceof Error ? err.message : String(err);
						const errorCode =
							err instanceof Error && "code" in err && typeof err.code === "string"
								? err.code
								: undefined;
						// Preserve the existing custom-operations protocol; native operations carry typed facts.
						const canceled = signal?.aborted || message === "aborted";
						const legacyTimeout = message.startsWith("timeout:")
							? message.slice("timeout:".length)
							: undefined;
						execution = {
							status: canceled ? "canceled" : "failed",
							reason: canceled
								? "canceled"
								: legacyTimeout !== undefined
									? "command_timeout"
									: spawnFailed
										? "spawn_failed"
										: "unknown",
							exitCode: null,
							...(canceled ? { cancellationReason: formatCancellationReason(signal) } : {}),
							...(errorCode ? { errorCode } : {}),
							message: canceled
								? "Command aborted"
								: legacyTimeout !== undefined
									? `Command timed out after ${legacyTimeout} seconds`
									: message,
						};
					}
					throw new BashExecutionError(
						appendStatus(text, execution.message ?? "Command failed"),
						resultDetails(finished, execution),
						{ cause: err },
					);
				}

				const finished = await finishOutput();
				const { text: outputText } = formatOutput(finished);
				const execution: BashExecutionOutcome = {
					status: !exitSignal && exitCode === 0 ? "succeeded" : "failed",
					reason: exitSignal ? "signaled" : exitCode === null ? "unknown" : "exited",
					exitCode,
					...(exitSignal ? { signal: exitSignal } : {}),
				};
				if (execution.status !== "succeeded") {
					execution.message = exitSignal
						? `Command terminated by signal ${exitSignal}`
						: exitCode === null
							? "Command terminated without an exit code"
							: `Command exited with code ${exitCode}`;
					throw new BashExecutionError(
						appendStatus(outputText, execution.message),
						resultDetails(finished, execution),
					);
				}
				return {
					content: [{ type: "text", text: outputText }],
					details: resultDetails(finished, execution),
				};
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
