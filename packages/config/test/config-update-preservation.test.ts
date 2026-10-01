import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConfigPath,
  resetConfig,
  setLegacyByokProviderMigrationEnabled,
  setManagedPresetBaseUrlSyncEnabled,
} from "../src/config.js";
import {
  compareAndSetLocalModelContext,
  updateLocalByokConfig,
  updateLocalModelSelection,
} from "../src/local-model-provider-write.js";
import {
  compareAndSetLocalModelContext as compareLegacyContext,
  updateLocalByokConfig as updateLegacyByok,
  updateLocalConfigFile,
} from "../../local-runtime/src/config/update.js";

const secret = "synthetic-config-preservation-key";
const contextInput = {
  providerId: "minimax",
  modelId: "synthetic-model",
  expectedContextLimit: 100,
  contextLimit: 200,
};
const writers = [
  [
    "permission mode",
    () => updateLocalConfigFile({ field: "permissionMode", set: "default" }),
  ],
  [
    "prepared payload",
    () =>
      updateLocalConfigFile({}, new Set(["thinking"]), {
        thinking: { effort: "high" },
      }),
  ],
  [
    "legacy BYOK",
    () =>
      updateLegacyByok((draft) => {
        draft.minimax_api = { apiKey: secret };
      }),
  ],
  [
    "legacy model context",
    () => compareLegacyContext(contextInput, async () => true),
  ],
  [
    "model selection",
    () => updateLocalModelSelection({ modelKey: "minimax/synthetic-model" }),
  ],
  [
    "BYOK",
    () =>
      updateLocalByokConfig((draft) => {
        draft.minimax_api = { apiKey: secret };
      }),
  ],
  [
    "model context",
    () => compareAndSetLocalModelContext(contextInput, async () => true),
  ],
] as const;

let root: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "mcode-config-preservation-"));
  dataDir = join(root, "profile");
  fs.mkdirSync(dataDir);
  vi.spyOn(os, "homedir").mockReturnValue(root);
  vi.stubEnv("MINIMAX_DATA_DIR", dataDir);
  vi.stubEnv("__MAVIS_RUNTIME_MANAGED", "0");
  resetConfig();
  setLegacyByokProviderMigrationEnabled(false);
  setManagedPresetBaseUrlSyncEnabled(false);
  configPath = getConfigPath();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfig();
  setLegacyByokProviderMigrationEnabled(true);
  setManagedPresetBaseUrlSyncEnabled(true);
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each(writers)("%s config updates", (_name, write) => {
  it.each([
    ["malformed YAML", `provider: [${secret}\n`],
    ["duplicate keys", `apiKey: ${secret}\napiKey: duplicate\n`],
    ["sequence", `- ${secret}\n`],
    ["scalar", `${secret}\n`],
    ["timestamp", "2026-01-01\n"],
  ])(
    "rejects %s without replacing the original file",
    async (_kind, source) => {
      fs.writeFileSync(configPath, source);
      const rename = vi.spyOn(fs.promises, "rename");

      await expect(write()).rejects.toThrow(/Invalid config\.yaml/);

      expect(fs.readFileSync(configPath, "utf8")).toBe(source);
      expect(rename).not.toHaveBeenCalled();
      expect(fs.readdirSync(dataDir)).toEqual(["config.yaml"]);
    },
  );

  it("does not expose configuration contents in parse errors", async () => {
    fs.writeFileSync(configPath, `provider: [${secret}\n`);

    const error = await write().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
  });

  it("aborts on a read failure and releases the lock", async () => {
    const source = `permissionMode: auto\n# ${secret}\n`;
    fs.writeFileSync(configPath, source);
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error(`EACCES ${secret}`), { code: "EACCES" });
    });
    const rename = vi.spyOn(fs.promises, "rename");

    await expect(write()).rejects.toThrow(
      "Local runtime failed to update config file",
    );

    read.mockRestore();
    expect(fs.readFileSync(configPath, "utf8")).toBe(source);
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readdirSync(dataDir)).toEqual(["config.yaml"]);
  });
});

describe("valid local config updates", () => {
  it.each([undefined, "", "# empty config\n", "{}\n", "null\n"])(
    "initializes a missing or empty document: %s",
    async (source) => {
      if (source !== undefined) fs.writeFileSync(configPath, source);
      await updateLocalConfigFile({ permissionMode: "default" });
      expect(yaml.load(fs.readFileSync(configPath, "utf8"))).toEqual({
        permissionMode: "default",
      });
    },
  );

  it("preserves unrelated settings and credentials", async () => {
    const source = {
      permissionMode: "auto",
      custom_provider: { example: { options: { apiKey: secret }, models: {} } },
      customSetting: { enabled: true },
    };
    fs.writeFileSync(configPath, yaml.dump(source));

    await updateLocalConfigFile({ field: "permissionMode", set: "default" });

    expect(yaml.load(fs.readFileSync(configPath, "utf8"))).toEqual({
      ...source,
      permissionMode: "default",
    });
  });

  it("can update the file after the user repairs malformed YAML", async () => {
    fs.writeFileSync(configPath, "provider: [");
    await expect(
      updateLocalConfigFile({ permissionMode: "default" }),
    ).rejects.toThrow();
    fs.writeFileSync(configPath, "permissionMode: auto\n");

    await updateLocalConfigFile({ permissionMode: "default" });

    expect(yaml.load(fs.readFileSync(configPath, "utf8"))).toEqual({
      permissionMode: "default",
    });
  });
});
