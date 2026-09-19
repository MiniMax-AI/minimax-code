import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { suiteFiles, repositoryRoot } from "./lib/vitest-suites.mjs";

const require = createRequire(import.meta.url);
const name = process.argv[2];
if (!name) throw new Error("Usage: node scripts/run-vitest-suite.mjs <suite>");
const files = suiteFiles(repositoryRoot, name);
const manifestPath = require.resolve("vitest/package.json");
const cli = path.resolve(path.dirname(manifestPath), require(manifestPath).bin.vitest);
// Windows runners expose TEMP through an 8.3 alias (RUNNER~1). Native
// fs.watch can abort inside libuv when events use the corresponding long path:
// https://github.com/libuv/libuv/issues/5010. Keep real filesystem watching in
// the tests, but create their temporary fixtures beneath the canonical path.
const environment = { ...process.env };
if (process.platform === "win32") {
  environment.TEMP = environment.TMP = realpathSync.native(tmpdir());
}
const result = spawnSync(
  process.execPath,
  [
    cli,
    "run",
    "--config",
    "vitest.oss.config.mjs",
    // These suites create many SQLite databases and watched directories. On
    // Windows, concurrent files can exhaust the 5s test budget through I/O
    // contention. Serialize files without relaxing individual test deadlines.
    ...(process.platform === "win32" ? ["--maxWorkers", "1"] : []),
    ...files,
  ],
  { stdio: "inherit", cwd: repositoryRoot, env: environment },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
