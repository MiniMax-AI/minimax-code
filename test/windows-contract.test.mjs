import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { checkWindowsSourceLocation } from "../scripts/check-windows-source-location.mjs";
import { resolveWslPath } from "../packages/tui/src/host/wsl-path.js";
import { McodeUpdateService } from "../packages/tui/src/update/service.js";

const windowsPath = String.raw`D:\Users\demo\Documents\Screen shots\截图.png`;
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  }
});

describe.skipIf(process.platform !== "win32")("Windows source contract", () => {
  it("accepts the Windows checkout on a local NTFS volume", () => {
    assert.deepEqual(checkWindowsSourceLocation(), {
      ok: true,
      skipped: false,
    });
  });

  it("preserves Windows path syntax on the native host", async () => {
    assert.equal(await resolveWslPath(windowsPath), windowsPath);
  });

  it.each(["standard npm", "custom npm wrapper", "custom npm wrapper with adjacent CLI"])("installs and validates a managed update in a complex path with %s", async (npmLayout) => {
    const root = mkdtempSync(path.join(tmpdir(), "mcode-update-"));
    temporaryRoots.push(root);
    const fixtureRoot = path.join(root, "package");
    mkdirSync(fixtureRoot);
    writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({
      name: "@minimax-ai/code",
      version: "1.2.4",
      bin: { mcode: "cli.cjs" },
    }));
    writeFileSync(path.join(fixtureRoot, "cli.cjs"), "#!/usr/bin/env node\nconsole.log('1.2.4');\n");
    const environment = {
      ...process.env,
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      npm_config_bin_links: "true",
      npm_config_cache: path.join(root, "cache"),
      npm_config_userconfig: path.join(root, "npmrc"),
    };
    writeFileSync(environment.npm_config_userconfig, "");
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const packed = JSON.parse(execFileSync(process.execPath, [
      npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", root,
    ], { cwd: fixtureRoot, env: environment, encoding: "utf8", timeout: 30_000 }));
    if (npmLayout !== "standard npm") {
      const wrapperRoot = path.join(root, "npm-wrapper");
      mkdirSync(wrapperRoot);
      let wrapperCli = npmCli;
      if (npmLayout === "custom npm wrapper with adjacent CLI") {
        wrapperCli = path.join(wrapperRoot, "node_modules", "npm", "bin", "npm-cli.js");
        mkdirSync(path.dirname(wrapperCli), { recursive: true });
        writeFileSync(wrapperCli, `require(${JSON.stringify(npmCli)});\n`);
      }
      environment.npm_config_bin_links = "false";
      writeFileSync(path.join(wrapperRoot, "npm.cmd"), `@echo off\r\nset "npm_config_bin_links=true"\r\necho used> "%~dp0invoked"\r\n"${process.execPath}" "${wrapperCli}" %*\r\n`);
      const pathKey = Object.keys(environment).filter((key) => key.toLowerCase() === "path").sort()[0];
      const inheritedPath = environment[pathKey];
      for (const key of Object.keys(environment)) {
        if (key.toLowerCase() === "path") delete environment[key];
      }
      environment.PATH = [wrapperRoot, inheritedPath].filter(Boolean).join(path.delimiter);
    }
    const artifact = readFileSync(path.join(root, packed[0].filename));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      product: "minimax-code",
      channel: "stable",
      version: "1.2.4",
      publishedAt: "2026-09-24T00:00:00.000Z",
      minNodeVersion: "22.19.0",
      registry: "https://registry.npmjs.org/",
      installArtifact: {
        url: "https://updates.example.invalid/mcode.tgz",
        sha256: createHash("sha256").update(artifact).digest("hex"),
        size: artifact.length,
      },
      targets: Object.fromEntries([
        "darwin-arm64", "darwin-x64", "linux-x64", "windows-x64", "windows-arm64",
      ].map((target) => [target, { sha256: "a".repeat(64), size: 1 }])),
    }));
    const signature = Buffer.from(sign(null, manifest, privateKey).toString("base64"));
    const installRoot = path.join(root, "用户 files & (test)");
    mkdirSync(installRoot);
    writeFileSync(path.join(installRoot, "current"), "1.2.3\n");
    const service = new McodeUpdateService({
      currentVersion: "1.2.3",
      installRoot,
      environment,
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
      releaseBaseUrl: "https://updates.example.invalid",
      dependencies: {
        fetchBytes: async (url) => url.endsWith(".sig") ? signature : url.endsWith(".tgz") ? artifact : manifest,
      },
    });
    const result = await service.apply({ channel: "stable" });
    assert.equal(result.applied, true);
    assert.equal(readFileSync(path.join(installRoot, "current"), "utf8"), "1.2.4\n");
    if (npmLayout !== "standard npm") {
      assert.match(readFileSync(path.join(root, "npm-wrapper", "invoked"), "utf8"), /^used/);
    }
  }, 60_000);
});
