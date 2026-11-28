import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { getWindowsAnsiCodePageEncoding } from "../src/core/tools/shell-encoding.ts";

type WindowsShell = { shell: string; type: "powershell" | "pwsh" | "bash"; args: string[] };

function findShells(): WindowsShell[] {
	if (process.platform !== "win32") return [];
	const shells: WindowsShell[] = [];
	const powershell = join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
	if (existsSync(powershell))
		shells.push({ shell: powershell, type: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command"] });
	const pwsh = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true, timeout: 3000 })
		.stdout?.trim()
		.split(/\r?\n/)[0];
	if (pwsh && existsSync(pwsh))
		shells.push({ shell: pwsh, type: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command"] });
	for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
		const bash = root ? join(root, "Git", "bin", "bash.exe") : undefined;
		if (bash && existsSync(bash)) {
			shells.push({ shell: bash, type: "bash", args: ["-c"] });
			break;
		}
	}
	return shells;
}

function findPython(): string | undefined {
	if (process.platform !== "win32") return undefined;
	const result = spawnSync("where.exe", ["python.exe"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
	for (const candidate of result.stdout?.trim().split(/\r?\n/) ?? []) {
		// Skip the Microsoft Store alias, which opens the Store instead of running Python.
		if (!candidate || candidate.includes("WindowsApps")) continue;
		const version = spawnSync(candidate, ["-c", "print(1)"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
		if (version.status === 0) return candidate;
	}
	return undefined;
}

const shells = findShells();
const python = findPython();
const NAME = "\u53f2\u5141\u5965"; // 史允奥

function quote(shell: WindowsShell, path: string): string {
	return shell.type === "bash" ? `'${path.replaceAll("\\", "/")}'` : `& '${path}'`;
}

describe
	.skipIf(shells.length === 0)
	.each(shells.length > 0 ? shells : [{ shell: "unavailable", type: "bash", args: [] } as WindowsShell])(
	"Windows native program output encoding: $type",
	(shell) => {
		let cwd: string;
		beforeAll(() => {
			cwd = mkdtempSync(join(tmpdir(), "pi-native-encoding-"));
		});
		afterAll(() => {
			rmSync(cwd, { recursive: true, force: true });
		});

		const run = async (command: string, env?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv) => {
			const tool = createBashTool(cwd, {
				operations: (await import("../src/core/tools/bash.ts")).createLocalBashOperations({ shellConfig: shell }),
				...(env ? { spawnHook: (context) => ({ ...context, env: env(context.env) }) } : {}),
			});
			const result = await tool.execute("native-encoding", { command, timeout: 30 });
			const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			return { text, stdout: result.details?.processOutput?.stdout ?? "" };
		};

		it.skipIf(!python)("Python prints Chinese and characters outside the ANSI code page", async () => {
			const result = await run(
				`${quote(shell, python!)} -c "import sys; print(chr(0x53f2)+chr(0x5141)+chr(0x5965)); print(chr(0x2714)); print(sys.stdout.encoding)"`,
				(env) => {
					const next = { ...env };
					for (const key of Object.keys(next)) if (/^PYTHON(IOENCODING|UTF8)$/i.test(key)) delete next[key];
					return next;
				},
			);
			expect(result.text).toContain(NAME);
			expect(result.text).toContain("\u2714");
			expect(result.text.toLowerCase()).toContain("utf-8");
			expect(result.text).not.toContain("\ufffd");
			expect(result.stdout).toContain(NAME);
		});

		it.skipIf(!python || getWindowsAnsiCodePageEncoding() !== "gbk")(
			"Python reads code page bytes piped from a native program",
			async () => {
				const writer = `${quote(shell, process.execPath)} -e "process.stdout.write(Buffer.from('cab7d4cab0c20d0a', 'hex'))"`;
				const reader = `${quote(shell, python!)} -c "import sys; data = sys.stdin.read(); print(len(data) > 0); sys.stdout.write(data)"`;
				const result = await run(`${writer} | ${reader}`, (env) => {
					const next: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
					for (const key of Object.keys(next)) if (/^PYTHON(IOENCODING|UTF8)$/i.test(key)) delete next[key];
					return next;
				});
				expect(result.text).not.toContain("UnicodeDecodeError");
				expect(result.text).toContain("True");
				// PowerShell re-encodes text between native programs, so only bash pipes the original bytes.
				if (shell.type === "bash") expect(result.text).toContain(NAME);
			},
		);

		it.skipIf(!python)("keeps a PYTHONIOENCODING value the user set", async () => {
			const result = await run(`${quote(shell, python!)} -c "import sys; print(sys.stdout.encoding)"`, (env) => ({
				...env,
				PYTHONIOENCODING: "ascii",
			}));
			expect(result.text.trim().toLowerCase()).toBe("ascii");
		});

		it.skipIf(getWindowsAnsiCodePageEncoding() !== "gbk")(
			"decodes a native program that writes the ANSI code page",
			async () => {
				const script =
					"process.stdout.write(Buffer.from('cab7d4cab0c20d0a', 'hex')); process.stdout.write('utf8 \\u4e2d\\u6587\\n')";
				const result = await run(`${quote(shell, process.execPath)} -e "${script}"`, (env) => ({
					...env,
					ELECTRON_RUN_AS_NODE: "1",
				}));
				expect(result.text).toContain(NAME);
				expect(result.text).toContain("utf8 \u4e2d\u6587");
				expect(result.text).not.toContain("\ufffd");
				expect(result.stdout).toContain(NAME);
			},
		);
	},
);
