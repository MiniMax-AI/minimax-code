import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, win32 } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	/** Shell type for platform-specific behavior (encoding prefix, etc.) */
	type: "bash" | "sh" | "pwsh" | "powershell";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", ["bash.exe"], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/** PowerShell spawn arguments (shared by pwsh 7+ and Windows PowerShell 5.1). */
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];

/**
 * Find a PowerShell executable on Windows.
 *
 * Probe order (mirrors pi-powershell's shell-resolve.ts):
 *   1. pwsh.exe on PATH (PowerShell 7+, native UTF-8)
 *   2. C:\Program Files\PowerShell\7\pwsh.exe
 *   3. Windows PowerShell 5.1 (powershell.exe, always present)
 */
function findPowerShell(): ShellConfig | null {
	// 1. pwsh on PATH
	try {
		const result = spawnSync("where", ["pwsh.exe"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch && existsSync(firstMatch)) {
				return { shell: firstMatch, args: PS_ARGS, type: "pwsh" };
			}
		}
	} catch {
		// Ignore errors
	}

	// 2. Known install location for PowerShell 7+
	const pwsh7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
	if (existsSync(pwsh7)) {
		return { shell: pwsh7, args: PS_ARGS, type: "pwsh" };
	}

	// 3. Windows PowerShell 5.1 (always present on Windows 10+)
	const ps51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
	if (existsSync(ps51)) {
		return { shell: ps51, args: PS_ARGS, type: "powershell" };
	}

	return null;
}

/**
 * Infer shell type from a custom shell path.
 *
 * Only the executable basename is inspected so that a user whose home folder or
 * intermediate directory contains "pwsh" / "powershell" (e.g.
 * `C:/Users/powershell-user/AppData/Local/Programs/Git/bin/bash.exe`) is not
 * misclassified as a PowerShell binary. Path separators are normalized with
 * `win32.basename` so the result is stable whether the caller is on Windows,
 * macOS, or Linux and whether the path uses backslashes or forward slashes.
 * The accepted names are:
 *   - `pwsh.exe` / `pwsh`            → pwsh
 *   - `powershell.exe` / `powershell` → powershell
 *   - everything else (including `bash`, `sh`, `zsh`, …) → bash
 */
function inferShellType(shellPath: string): ShellConfig["type"] {
	// `win32.basename` treats both `\` and `/` as separators and is exported on
	// every platform, so it returns the trailing component regardless of where
	// this code is running. Using the host's default `basename` would split
	// only on POSIX separators and miss Windows backslash paths on macOS/Linux
	// (and vice versa).
	const lower = win32.basename(shellPath).toLowerCase();
	if (lower === "pwsh.exe" || lower === "pwsh") return "pwsh";
	if (lower === "powershell.exe" || lower === "powershell") return "powershell";
	return "bash";
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: PowerShell (pwsh 7+ → 5.1) → Git Bash → bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			const shellType = inferShellType(customShellPath);
			const args = shellType === "bash" || shellType === "sh" ? ["-c"] : PS_ARGS;
			return { shell: customShellPath, args, type: shellType };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Prefer PowerShell (system-native, no MSYS path issues)
		const ps = findPowerShell();
		if (ps) return ps;

		// 3. Fallback: try Git Bash in known locations
		const gitBashPaths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			gitBashPaths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			gitBashPaths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const p of gitBashPaths) {
			if (existsSync(p)) {
				return { shell: p, args: ["-c"], type: "bash" };
			}
		}

		// 4. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"], type: "bash" };
		}

		throw new Error(
			`No shell found. Options:\n` +
				`  1. PowerShell should be available on Windows 10+ by default\n` +
				`  2. Install Git for Windows: https://git-scm.com/download/win\n` +
				"  3. Set shellPath in settings.json\n",
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"], type: "bash" };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"], type: "bash" };
	}

	return { shell: "sh", args: ["-c"], type: "sh" };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/** Grace window between the initial process-tree SIGTERM and SIGKILL. */
export const PROCESS_TREE_TERM_GRACE_MS = 3000;

export interface ParentDeathGuard {
	/** Resolves only after the guardian has durably registered this target. */
	ready: Promise<void>;
	disarm(): Promise<void>;
}

export interface ProcessTreeTermination {
	(): void;
	/** Resolves after cancellation or after the force-kill escalation is sent. */
	settled: Promise<void>;
}

const PARENT_DEATH_GUARD_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { win32 } from "node:path";

const initialPid = Number.parseInt(process.argv[1] ?? "", 10);
const initialGraceMs = Number.parseInt(process.argv[2] ?? "3000", 10);
const initialLeaseId = process.argv[3] ?? "";
const targets = new Map();
if (initialLeaseId && Number.isFinite(initialPid) && initialPid > 0) {
  targets.set(initialLeaseId, { pid: initialPid, graceMs: initialGraceMs });
}
let armed = true;
const keepAlive = setInterval(() => undefined, 60000);

const killUnix = (targetPid, signal) => {
  try { process.kill(-targetPid, signal); }
  catch {
    try { process.kill(targetPid, signal); } catch {}
  }
};

const taskkill = (targetPid, force) => {
  const root = process.env.SystemRoot || process.env.windir;
  const executable = root ? win32.join(root, "System32", "taskkill.exe") : "taskkill.exe";
  try {
    const child = spawn(executable, [...(force ? ["/F"] : []), "/T", "/PID", String(targetPid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    const fallbackKill = () => {
      try { process.kill(targetPid, "SIGKILL"); } catch {}
    };
    child.once("error", fallbackKill);
    child.unref();
  } catch {
    try { process.kill(targetPid, "SIGKILL"); } catch {}
  }
};

const terminate = () => {
  if (!armed) return;
  armed = false;
  if (targets.size === 0) {
    clearInterval(keepAlive);
    process.exit(0);
  }
  for (const { pid: targetPid } of targets.values()) {
    if (process.platform === "win32") taskkill(targetPid, false);
    else killUnix(targetPid, "SIGTERM");
  }
  const graceMs = Math.max(0, ...[...targets.values()].map((target) => target.graceMs));
  setTimeout(() => {
    for (const { pid: targetPid } of targets.values()) {
      if (process.platform === "win32") taskkill(targetPid, true);
      else killUnix(targetPid, "SIGKILL");
    }
    clearInterval(keepAlive);
    process.exit(0);
  }, graceMs);
};

process.once("disconnect", terminate);
process.once("SIGTERM", terminate);
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  const pid = Number(message.pid);
  const leaseId = typeof message.leaseId === "string" ? message.leaseId : "";
  if (!leaseId || !Number.isFinite(pid) || pid <= 0) return;
  if (message.type === "arm") {
    targets.set(leaseId, { pid, graceMs: Math.max(0, Number(message.graceMs) || 0) });
    process.send?.({ type: "armed", leaseId, pid });
    return;
  }
  if (message.type !== "disarm") return;
  targets.delete(leaseId);
  process.send?.({ type: "disarmed", leaseId, pid });
});
if (initialLeaseId && Number.isFinite(initialPid) && initialPid > 0) {
  process.send?.({ type: "armed", leaseId: initialLeaseId, pid: initialPid });
}
if (!process.connected) terminate();
`;

let sharedParentDeathGuardian: ReturnType<typeof spawn> | undefined;

function spawnParentDeathGuardian(
	targetPid: number,
	graceMs: number,
	leaseId: string,
): ReturnType<typeof spawn> | undefined {
	let guardian: ReturnType<typeof spawn>;
	try {
		guardian = spawn(
			process.execPath,
			["--input-type=module", "--eval", PARENT_DEATH_GUARD_SOURCE, String(targetPid), String(graceMs), leaseId],
			{
				detached: true,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				windowsHide: true,
				env: {
					...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
					...(process.env.windir ? { windir: process.env.windir } : {}),
					...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				},
			},
		);
	} catch {
		return undefined;
	}
	sharedParentDeathGuardian = guardian;
	const forget = () => {
		if (sharedParentDeathGuardian === guardian) sharedParentDeathGuardian = undefined;
	};
	guardian.once("error", forget);
	guardian.once("exit", forget);
	guardian.unref();
	guardian.channel?.unref?.();
	return guardian;
}

/**
 * Start a tiny detached supervisor for a process group. Its IPC channel is a
 * parent-liveness lease: an uncatchable parent death closes the channel, so
 * the supervisor can still terminate the detached command tree.
 */
export function armParentDeathGuard(
	targetPid: number,
	graceMs: number = PROCESS_TREE_TERM_GRACE_MS,
): ParentDeathGuard | undefined {
	if (!Number.isFinite(targetPid) || targetPid <= 0) return undefined;
	const leaseId = randomUUID();
	const existing = sharedParentDeathGuardian?.connected ? sharedParentDeathGuardian : undefined;
	const guardian = existing ?? spawnParentDeathGuardian(targetPid, graceMs, leaseId);
	if (!guardian) return undefined;
	const ready = waitForGuardianMessage(guardian, "armed", targetPid, leaseId, {
		type: "arm",
		leaseId,
		pid: targetPid,
		graceMs,
	});
	let disarmed = false;
	return {
		ready,
		disarm: async () => {
			await ready.catch(() => undefined);
			await new Promise<void>((resolve) => {
				if (disarmed || !guardian.connected) {
					disarmed = true;
					resolve();
					return;
				}
				disarmed = true;
				const finish = () => {
					clearTimeout(timeout);
					guardian.off("message", onMessage);
					guardian.off("exit", finish);
					resolve();
				};
				const onMessage = (message: unknown) => {
					if (
						message &&
						typeof message === "object" &&
						(message as { type?: unknown }).type === "disarmed" &&
						(message as { leaseId?: unknown }).leaseId === leaseId &&
						(message as { pid?: unknown }).pid === targetPid
					) {
						finish();
					}
				};
				const timeout = setTimeout(finish, 1000);
				guardian.on("message", onMessage);
				guardian.once("exit", finish);
				guardian.send({ type: "disarm", leaseId, pid: targetPid }, (error) => {
					if (error) finish();
				});
			});
		},
	};
}

function waitForGuardianMessage(
	guardian: ReturnType<typeof spawn>,
	type: "armed",
	targetPid: number,
	leaseId: string,
	message?: { type: "arm"; leaseId: string; pid: number; graceMs: number },
): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			guardian.off("message", onMessage);
			guardian.off("exit", onExit);
			guardian.off("error", onError);
			if (error) reject(error);
			else resolve();
		};
		const onMessage = (received: unknown) => {
			if (
				received &&
				typeof received === "object" &&
				(received as { type?: unknown }).type === type &&
				(received as { leaseId?: unknown }).leaseId === leaseId &&
				(received as { pid?: unknown }).pid === targetPid
			) {
				finish();
			}
		};
		const onExit = () => finish(new Error("Parent-death guardian exited before target registration"));
		const onError = (error: Error) => finish(error);
		const timeout = setTimeout(() => finish(new Error("Parent-death guardian target registration timed out")), 1000);
		guardian.on("message", onMessage);
		guardian.once("exit", onExit);
		guardian.once("error", onError);
		if (message) {
			guardian.send(message, (error) => {
				if (error) finish(error);
			});
		}
	});
}

/**
 * Grace window (ms) between the initial SIGTERM and the SIGKILL escalation in
 * terminateProcessTreeGracefully. Long enough for a shell `trap ... TERM`
 * cleanup handler to run; only ever elapses for processes that ignore SIGTERM,
 * since the caller cancels the escalation once the process actually exits.
 */
export function resolveWindowsTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
	const systemRootKey = Object.keys(env).find((key) => key.toLowerCase() === "systemroot");
	const windirKey = Object.keys(env).find((key) => key.toLowerCase() === "windir");
	const windowsRoot = (systemRootKey ? env[systemRootKey] : undefined) ?? (windirKey ? env[windirKey] : undefined);
	return windowsRoot ? win32.join(windowsRoot, "System32", "taskkill.exe") : "taskkill.exe";
}

/**
 * Spawn the native Windows process-tree killer without trusting PATH.
 * Spawn failures arrive through an asynchronous `error` event, so fall back
 * to terminating the root shell and let the caller's timeout/abort settle.
 */
export function spawnWindowsTaskkill(pid: number, force: boolean, env: NodeJS.ProcessEnv = process.env): void {
	const fallbackKill = () => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already exited or cannot be addressed.
		}
	};

	try {
		const child = spawn(resolveWindowsTaskkillPath(env), [...(force ? ["/F"] : []), "/T", "/PID", String(pid)], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		child.once("error", fallbackKill);
		child.unref();
	} catch {
		fallbackKill();
	}
}

/**
 * Gracefully terminate a detached process tree: signal the process GROUP with
 * SIGTERM first so shell `trap ... TERM/INT` cleanup handlers can run, then
 * escalate to SIGKILL after a grace window if the tree is still alive.
 *
 * Returns a canceller that clears the pending escalation. Call it once the
 * process has actually exited so a late SIGKILL never lands on a reused
 * PID/PGID. Unlike {@link killProcessTree} (immediate SIGKILL, used for the
 * emergency node-exit cleanup), this is for user-initiated stop and timeout
 * paths where losing the cleanup trap is a real defect.
 */
export function terminateProcessTreeGracefully(
	pid: number,
	graceMs: number = PROCESS_TREE_TERM_GRACE_MS,
): ProcessTreeTermination {
	let resolveSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	let finished = false;
	let timer: NodeJS.Timeout;
	const finish = () => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		resolveSettled();
	};
	if (process.platform === "win32") {
		// Graceful pass first (no /F), then force-kill the tree after the grace window.
		spawnWindowsTaskkill(pid, false);
		timer = setTimeout(() => {
			spawnWindowsTaskkill(pid, true);
			finish();
		}, graceMs);
		timer.unref?.();
		return Object.assign(finish, { settled });
	}

	// Unix: SIGTERM the process group, escalate to SIGKILL after the grace window.
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Process already dead.
		}
	}
	timer = setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead.
			}
		}
		finish();
	}, graceMs);
	timer.unref?.();
	return Object.assign(finish, { settled });
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		spawnWindowsTaskkill(pid, true);
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
