import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Single definition of the full verification pipeline. GitHub CI runs `pnpm verify`
// so a local run executes the same gates in the same order; previously the order
// only existed inside the workflow file and could not be reproduced locally.
// Platform-conditional gates declare the platforms they support instead of being
// filtered by workflow `if:` expressions.
const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "full" },
    list: { type: "boolean", default: false },
  },
});
const profile = values.profile;
if (!["full", "platform", "windows", "docs", "archive", "package"].includes(profile))
  throw new Error(`Unknown verification profile: ${profile}`);
if (profile === "windows" && process.platform !== "win32")
  throw new Error("Windows verification profile requires a Windows host");
if (profile === 'package' && !['darwin', 'linux'].includes(process.platform))
  throw new Error('Package verification currently supports Linux and macOS only.');
// Listing must not leave a temporary export directory behind.
const temporary = values.list
  ? undefined
  : mkdtempSync(path.join(tmpdir(), "mcode-verify-"));
const preview = path.join(temporary ?? tmpdir(), "minimax-code-source.tar.gz");

const steps = [
  { name: "check:source", script: "check:source", docs: true, windows: true },
  { name: "check:tsconfig", script: "check:tsconfig", docs: true, windows: true },
  {
    name: "export source preview",
    docs: true,
    windows: true,
    requiresGit: true,
    command: ["scripts/export-source-preview.mjs", "--out", preview],
  },
  { name: "test:release-tools", script: "test:release-tools", docs: true, windows: true },
  { name: "lint:tui", script: "lint:tui", windows: true },
  // Compiler inputs are identical across the matrix. One Linux job runs this;
  // all platforms still build and validate native artifacts on their own platform.
  { name: "typecheck", script: "typecheck", fullOnly: true },
  { name: "build", script: "build", windows: true },
  { name: "check:standalone", script: "check:standalone", windows: true },
  { name: "test:artifact", script: "test:artifact", windows: true },
  { name: "test:capabilities", script: "test:capabilities" },
  { name: "test:windows", script: "test:windows", platforms: ["win32"], windows: true },
  { name: "test:status-contract", script: "test:status-contract" },
  { name: "test:smoke", script: "test:smoke" },
  { name: "test:byok", script: "test:byok" },
  // The permission facade uses POSIX process and filesystem semantics.
  {
    name: "test:policy",
    script: "test:policy",
    platforms: ["darwin", "linux"],
  },
  // Seatbelt sandbox backend; only macOS provides the native helper.
  { name: "test:sandbox", script: "test:sandbox", platforms: ["darwin"] },
  {
    name: "test:release-package",
    command: ['scripts/verify-cli-release.mjs'],
    packageOnly: true,
    platforms: ['darwin', 'linux'],
  },
];

function skipReason(step) {
  if (profile === 'package' && !step.packageOnly) return 'validating an npm release archive';
  if (profile !== 'package' && step.packageOnly) return 'requires an npm release archive';
  if (profile === "windows" && !step.windows) return "not part of Windows contract";
  if (profile === "docs" && !step.docs) return "documentation-only change";
  if (profile === "archive" && step.requiresGit)
    return "validating an already exported archive";
  if (step.platforms && !step.platforms.includes(process.platform))
    return "not applicable on this platform";
  if (step.fullOnly && profile === "platform")
    return "covered by the full profile";
  return null;
}
const planned = steps.filter((step) => !skipReason(step));

if (values.list) {
  for (const step of planned) console.log(step.name);
  process.exit(0);
}

// `npm_execpath` may be a JavaScript entry point or a native package-manager
// binary depending on how pnpm was installed, so dispatch on what it actually is
// instead of assuming it can be passed to node.
function runScript(name) {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.[cm]?js$/u.test(execPath))
    return spawnSync(process.execPath, [execPath, "run", name], {
      stdio: "inherit",
      cwd: root,
    });
  const command = execPath ?? "pnpm";
  const shell = process.platform === "win32";
  return spawnSync(shell ? `"${command}"` : command, ["run", name], {
    stdio: "inherit",
    cwd: root,
    shell,
  });
}

function run(step) {
  const group = Boolean(process.env.GITHUB_ACTIONS);
  if (group) console.log(`::group::${step.name}`);
  else console.log(`\n=== ${step.name} ===`);
  try {
    return step.script
      ? runScript(step.script)
      : spawnSync(process.execPath, step.command, {
          stdio: "inherit",
          cwd: root,
        });
  } finally {
    if (group) console.log("::endgroup::");
  }
}

const started = performance.now();
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
});
const report = {
  schemaVersion: 1,
  // The candidate workflow authenticates its receipt before running this
  // profile in a source-only directory that deliberately contains no .git.
  revision:
    revision.status === 0
      ? revision.stdout.trim()
      : profile === "archive" &&
          /^[a-f0-9]{40}$/u.test(process.env.MCODE_VERIFY_REVISION ?? "")
        ? process.env.MCODE_VERIFY_REVISION
        : null,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  profile,
  startedAt: new Date().toISOString(),
  durationMs: 0,
  status: "RUNNING",
  gates: steps.map((step) => ({
    name: step.name,
    status: skipReason(step) ? "SKIP" : "NOT_RUN",
    reason: skipReason(step),
    durationMs: null,
  })),
};
const reportDir = process.env.MCODE_VERIFY_REPORT_DIR;
function saveReport() {
  report.durationMs = Math.round(performance.now() - started);
  if (!reportDir) return;
  mkdirSync(reportDir, { recursive: true });
  const target = path.join(reportDir, "verification.json");
  // Keep the last complete JSON readable even if the runner is interrupted.
  writeFileSync(`${target}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${target}.tmp`, target);
}
function summary() {
  return [
    `## Verification: ${report.status}`,
    "",
    `${report.platform}/${report.arch}, Node ${report.node}, profile ${profile}`,
    `Revision: ${report.revision ?? "unavailable"}`,
    `Elapsed: ${(report.durationMs / 1000).toFixed(1)}s`,
    "",
    "| Gate | Result | Seconds | Detail |",
    "| --- | --- | ---: | --- |",
    ...report.gates.map((gate) => {
      const detail =
        gate.reason ??
        (gate.errorCode
          ? `spawn error ${gate.errorCode}`
          : gate.signal
            ? `signal ${gate.signal}`
            : gate.exitCode != null
              ? `exit ${gate.exitCode}`
              : "");
      return `| ${gate.name} | ${gate.status} | ${gate.durationMs == null ? "—" : (gate.durationMs / 1000).toFixed(1)} | ${detail} |`;
    }),
    "",
    "Reports contain gate metadata only. Failure output remains in the corresponding job log.",
    "",
  ].join("\n");
}

let failed;
try {
  saveReport();
  for (const step of planned) {
    const gate = report.gates.find((entry) => entry.name === step.name);
    gate.status = "RUNNING";
    saveReport();
    const gateStarted = performance.now();
    let result;
    try {
      result = run(step);
    } catch (error) {
      result = { error, status: null, signal: null };
    }
    gate.durationMs = Math.round(performance.now() - gateStarted);
    gate.exitCode = result.status;
    gate.signal = result.signal;
    gate.errorCode = result.error ? (result.error.code ?? "SPAWN_ERROR") : null;
    gate.status = result.status === 0 && !result.error ? "PASS" : "FAIL";
    console.log(
      `${step.name}: ${gate.status} (${(gate.durationMs / 1000).toFixed(1)}s)`,
    );
    saveReport();
    if (gate.status === "FAIL") {
      failed = step.name;
      break;
    }
  }
  report.status = failed ? "FAIL" : "PASS";
} finally {
  rmSync(temporary, { recursive: true, force: true });
  for (const gate of report.gates)
    if (gate.status === "NOT_RUN")
      gate.reason = "verification stopped before this gate";
  saveReport();
  const markdown = summary();
  if (reportDir)
    writeFileSync(path.join(reportDir, "verification.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}
if (failed) {
  console.error(`\nVerification failed at: ${failed}`);
  process.exitCode = 1;
} else {
  const skipped = steps
    .filter((step) => !planned.includes(step))
    .map((step) => `${step.name} (${skipReason(step)})`);
  console.log(
    `\nVerification passed: ${planned.length} gates on ${process.platform}.` +
      (skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""),
  );
}
