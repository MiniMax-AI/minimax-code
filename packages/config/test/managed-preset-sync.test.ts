import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConfig,
  resetConfig,
  setLegacyByokProviderMigrationEnabled,
  setManagedPresetBaseUrlSyncEnabled,
} from "../src/config.js";
import { loadConfigFromFile } from "../src/file-loader.js";

const secret = "synthetic-preset-sync-secret";
const oldBaseURL = "https://agent.minimax.io/mavis/api/v1/llm/v1";
const presetBaseURL =
  "https://matrix-overseas-pre.example.invalid/mavis/api/v1/llm/v1";
const original = yaml.dump({
  logLevel: "debug",
  provider: { minimax: { options: { baseURL: oldBaseURL, apiKey: secret } } },
  custom_provider: { example: { options: { apiKey: secret }, models: {} } },
});
let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "managed-preset-sync-"));
  file = join(root, "config.yaml");
  vi.stubEnv("__MAVIS_RUNTIME_MANAGED", "1");
  vi.stubEnv("__MAVIS_RUNTIME_DATA_DIR", root);
  vi.stubEnv("MINIMAX_DATA_DIR", root);
  vi.stubEnv("MAVIS_REGION", "en");
  vi.stubEnv("MAVIS_BUILD_ENV", "staging");
  setLegacyByokProviderMigrationEnabled(false);
  setManagedPresetBaseUrlSyncEnabled(true);
  resetConfig();
  fs.writeFileSync(file, original, { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfig();
  setLegacyByokProviderMigrationEnabled(true);
  setManagedPresetBaseUrlSyncEnabled(true);
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each([
  ["default config", () => getConfig()],
  ["explicit config", () => loadConfigFromFile(file, { dataDir: root })],
] as const)("%s preset synchronization", (_name, load) => {
  it("persists the current preset and preserves user settings", () => {
    const config = load();
    expect(config.logLevel).toBe("debug");
    expect(config.provider.minimax?.options).toMatchObject({
      baseURL: presetBaseURL,
      apiKey: secret,
    });
    const persisted = yaml.load(fs.readFileSync(file, "utf8"));
    expect(persisted).toMatchObject({
      custom_provider: { example: { options: { apiKey: secret } } },
      provider: {
        minimax: { options: { baseURL: presetBaseURL, apiKey: secret } },
      },
    });
  });

  it.each(["openSync", "fchmodSync", "ftruncateSync"] as const)(
    "loads the effective preset when %s fails without changing the file",
    (operation) => {
      const failure = Object.assign(new Error(secret), { code: "EPERM" });
      if (operation === "openSync") {
        const open = fs.openSync;
        vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
          if (
            flags === "a" ||
            (typeof flags === "number" && flags & fs.constants.O_WRONLY)
          ) {
            throw failure;
          }
          return open(path, flags, mode);
        });
      } else {
        vi.spyOn(fs, operation).mockImplementation(() => {
          throw failure;
        });
      }
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config = load();
      expect(config.logLevel).toBe("debug");
      expect(config.provider.minimax?.options).toMatchObject({
        baseURL: presetBaseURL,
        apiKey: secret,
      });
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("preset baseURL sync skipped"),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    },
  );

  it("does not hide a failure after the original file has been truncated", () => {
    const failure = new Error("synthetic write failure");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw failure;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => load()).toThrow(failure);
    expect(warn).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe("");
  });

  it("preserves the write error when the original file cannot be verified", () => {
    const failure = new Error("synthetic truncate failure");
    let failed = false;
    vi.spyOn(fs, "ftruncateSync").mockImplementation(() => {
      failed = true;
      throw failure;
    });
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (failed && args[0] === file) throw new Error("synthetic read failure");
      return read(...args);
    });
    expect(() => load()).toThrow(failure);
  });
});

it("honors the disabled preset synchronization policy", () => {
  setManagedPresetBaseUrlSyncEnabled(false);
  const truncate = vi.spyOn(fs, "ftruncateSync");
  expect(getConfig().provider.minimax?.options?.baseURL).toBe(presetBaseURL);
  expect(truncate).not.toHaveBeenCalled();
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

it.each([
  ["prod", oldBaseURL],
  ["test", presetBaseURL],
] as const)(
  "preserves %s provider policy after a safe sync failure",
  (buildEnv, expectedBaseURL) => {
    vi.stubEnv("MAVIS_BUILD_ENV", buildEnv);
    // A staging endpoint needs syncing in both prod and test builds.
    fs.writeFileSync(file, original.replace(oldBaseURL, presetBaseURL));
    vi.spyOn(fs, "ftruncateSync").mockImplementation(() => {
      throw new Error("synthetic failure");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = getConfig();
    expect(config.provider.minimax?.options?.baseURL).toBe(expectedBaseURL);
    expect(config.provider.minimax?.options?.apiKey).toBe(secret);
  },
);

it("still reports failure when creating the required initial config", () => {
  fs.unlinkSync(file);
  const failure = Object.assign(new Error("synthetic create failure"), {
    code: "EPERM",
  });
  vi.spyOn(fs, "openSync").mockImplementation(() => {
    throw failure;
  });
  expect(() => getConfig()).toThrow(failure);
});
