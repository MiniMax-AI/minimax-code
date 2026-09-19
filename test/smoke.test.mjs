import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { withoutProxyEnvironment } from "./offline-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "dist/cli.js");
// Full runtime startup can exceed 15s on Windows CI (ACP took 22s).
// Match the ACP startup budget; lightweight help/validation stays at 15s.
const runtimeTimeoutMs = process.platform === "win32" ? 30000 : 15000;
function assertSuccessfulChild(result) {
  assert.equal(result.error, undefined,
    `CLI spawn failed: ${result.error?.message}; signal=${result.signal}; stderr=${result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
}
const version = JSON.parse(
  readFileSync(path.join(root, "packages/tui/package.json"), "utf8"),
).version;
function fixture(t, environment = process.env) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "minimax-code-smoke-"));
  const audit = path.join(dataDir, "network-attempts.log");
  t.after(() => {
    try {
      assert.equal(
        existsSync(audit),
        false,
        existsSync(audit)
          ? readFileSync(audit, "utf8")
          : "Unexpected outbound network attempt",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  return {
    cwd: dataDir,
    env: {
      ...withoutProxyEnvironment(environment),
      MINIMAX_DATA_DIR: dataDir,
      MAVIS_DATA_DIR: dataDir,
      MCODE_TEST_NETWORK_AUDIT: audit,
      MCODE_TEST_MANAGED_OFFLINE: "1",
      MCODE_TEST_PROCESS_PROBE: "1",
      NODE_OPTIONS: `--import=${new URL("./network-deny.mjs", import.meta.url).href}`,
    },
  };
}
test("CLI version and command help work outside the source directory", (t) => {
  const options = fixture(t);
  for (const [args, expected] of [
    [["--version"], version],
    [["--help"], "terminal coding agent"],
    [["exec", "--help"], "prompt"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      ...options,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(expected), result.stdout);
  }
});
test("CLI defaults to the shared user config without migrating the old source directory", (t) => {
  const options = fixture(t);
  const home = options.cwd;
  const config = path.join(home, ".minimax", "config.yaml");
  const oldConfig = path.join(home, ".minimax-code", "config.yaml");
  for (const file of [config, oldConfig]) mkdirSync(path.dirname(file));
  writeFileSync(config, "telemetry:\n  enabled: true\n", { mode: 0o600 });
  const oldContents = "telemetry:\n  enabled: false\n";
  writeFileSync(oldConfig, oldContents, { mode: 0o600 });
  for (const name of Object.keys(options.env)) {
    if (name.startsWith("__MAVIS_RUNTIME")) delete options.env[name];
  }
  delete options.env.MINIMAX_DATA_DIR;
  delete options.env.MAVIS_DATA_DIR;
  Object.assign(options.env, {
    HOME: home,
    USERPROFILE: home,
    MCODE_DISABLE_TELEMETRY: "1",
  });
  const result = spawnSync(process.execPath, [cli, "telemetry", "status"], {
    ...options,
    encoding: "utf8",
    timeout: runtimeTimeoutMs,
  });
  assertSuccessfulChild(result);
  const status = JSON.parse(result.stdout);
  assert.equal(status.configFile, config);
  assert.equal(status.configured, true);
  assert.equal(readFileSync(oldConfig, "utf8"), oldContents);
});
test("provider configuration loads from an isolated data directory", (t) => {
  const result = spawnSync(process.execPath, [cli, "provider", "list"], {
    ...fixture(t),
    encoding: "utf8",
    timeout: runtimeTimeoutMs,
  });
  assertSuccessfulChild(result);
  assert.match(result.stdout, /minimax/);

  assert.doesNotMatch(result.stdout, /custom_provider:/);
});
test("config permission failures preserve private reads and terminate unsafe startup", {
  skip: process.platform !== "darwin",
}, (t) => {
  const options = fixture(t);
  const config = path.join(options.env.MINIMAX_DATA_DIR, "config.yaml");
  const backup = `${config}.bak.byok-legacy-provider.smoke`;
  const flag = (file, value) => {
    const result = spawnSync("chflags", [value, file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const list = () => {
    const result = spawnSync(process.execPath, [cli, "provider", "list"], {
      ...options,
      encoding: "utf8",
      timeout: 15000,
      // A leaked startup watcher can handle SIGTERM without releasing the process.
      killSignal: "SIGKILL",
    });
    assert.equal(result.error, undefined, result.stderr);
    return result;
  };
  try {
    for (const file of [config, backup]) {
      writeFileSync(file, "logLevel: info\n", { mode: 0o400 });
      flag(file, "uchg");
    }
    const privateRead = list();
    assert.equal(privateRead.status, 0, privateRead.stderr);
    assert.doesNotMatch(privateRead.stderr, /Could not restrict legacy BYOK backup/);
    assert.equal(statSync(config).mode & 0o777, 0o400);
    assert.equal(statSync(backup).mode & 0o777, 0o400);

    flag(backup, "nouchg");
    chmodSync(backup, 0o644);
    flag(backup, "uchg");
    const backupWarning = list();
    assert.equal(backupWarning.status, 0, backupWarning.stderr);
    assert.match(backupWarning.stderr, /Could not restrict legacy BYOK backup/);
    assert.ok(backupWarning.stderr.includes(JSON.stringify(backup)));
    assert.equal(statSync(backup).mode & 0o777, 0o644);

    flag(config, "nouchg");
    chmodSync(config, 0o644);
    flag(config, "uchg");
    const unsafeRead = list();
    assert.equal(unsafeRead.status, 1, unsafeRead.stderr);
    assert.match(unsafeRead.stderr, /EPERM/);
    assert.equal(statSync(config).mode & 0o777, 0o644);
  } finally {
    for (const file of [config, backup]) {
      if (existsSync(file)) flag(file, "nouchg");
    }
  }
});

test("offline smoke children ignore ambient proxy variables", async (t) => {
  const proxyNames = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ];
  for (const name of proxyNames) {
    await t.test(name, (t) => {
      const environment = {
        ...process.env,
        ...Object.fromEntries(proxyNames.map((key) => [key, ""])),
        [name]: "http://127.0.0.1:9",
      };
      const options = fixture(t, environment);
      const result = spawnSync(process.execPath, [cli, "provider", "list"], {
        ...options,
        encoding: "utf8",
        timeout: runtimeTimeoutMs,
      });
      assertSuccessfulChild(result);
      assert.match(result.stdout, /minimax/);
      assert.match(
        readFileSync(options.env.MCODE_TEST_NETWORK_AUDIT + ".managed", "utf8"),
        /https:\/\/models\.dev\/api\.json|\/mavis\/api\/v1\/models-dev\/catalog/,
      );
      assert.equal(environment[name], "http://127.0.0.1:9");
    });
  }
});
test("native SQLite binding opens and reads a real database", () => {
  const db = new Database(":memory:");
  try {
    assert.equal(db.prepare("select 42 as value").get().value, 42);
  } finally {
    db.close();
  }
});
test(
  "ACP starts the real runtime and answers initialize over stdio",
  { timeout: 45000 },
  async (t) => {
    const child = spawn(process.execPath, [cli, "acp"], {
      ...fixture(t),
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const response = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error(`ACP initialize timed out: ${stderr}`)),
        30000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`ACP exited ${code}: ${stderr}`));
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const message = JSON.parse(line);
            if (message.id === 1) {
              clearTimeout(timer);
              resolve(message);
            }
          } catch {
            reject(new Error(`Non-JSON ACP stdout: ${line}`));
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: { _meta: { "terminal-auth": true } },
            clientInfo: { name: "minimax-code-smoke", version: "1" },
          },
        }) + "\n",
      );
    });
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.equal(response.result.protocolVersion, 1);
    assert.equal(response.result.authMethods[0].id, "minimax-code-login");
    assert.equal(response.result.agentInfo.version, version);
    child.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("ACP did not shut down after EOF"));
      }, 10000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error(`ACP shutdown ${code}: ${stderr}`));
      });
    });
  },
);

test("internal environment overrides are rejected", (t) => {
  const options = fixture(t);
  for (const args of [
    ["--lane", "internal"],
    ["--env", "test"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      ...options,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.notEqual(
      result.status,
      0,
      `${args.join(" ")} unexpectedly succeeded`,
    );
    assert.equal(result.error, undefined);
  }
});

test("local plugin browsing remains available with managed services offline", (t) => {
  const options = fixture(t);
  for (const args of [
    ["plugin", "list", "--marketplace", "local", "--json"],
    ["plugin", "list", "--available", "--marketplace", "local", "--json"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      ...options,
      encoding: "utf8",
      timeout: runtimeTimeoutMs,
    });
    assertSuccessfulChild(result);
    const output = JSON.parse(result.stdout);
    assert.ok(output !== null);
    assert.doesNotMatch(result.stdout, /"official"/);
  }
});

 test("managed commands remain discoverable without logging in", (t) => {
  for (const args of [["login", "--help"], ["logout", "--help"], ["update", "--help"], ["acp", "login", "--help"], ["provider", "use", "--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { ...fixture(t), encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
});

test("provider add validates token limits before opening the runtime", (t) => {
  const options = fixture(t);
  const args = [
    "provider", "add", "--name", "Invalid limits", "--base-url", "http://127.0.0.1:1/v1",
    "--model", "synthetic-model",
  ];
  for (const flag of ["--context-limit", "--output-limit"]) {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
      const result = spawnSync(process.execPath, [cli, ...args, `${flag}=${value}`], {
        ...options, encoding: "utf8", timeout: 15000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /positive safe integer/);
      assert.ok(result.stderr.includes(flag), result.stderr);
    }
  }
  assert.equal(existsSync(path.join(options.cwd, "config.yaml")), false);
});
