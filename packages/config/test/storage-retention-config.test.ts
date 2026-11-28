import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigFromRaw } from "../src/config.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(join(os.tmpdir(), "mcode-storage-retention-"));
  vi.stubEnv("MINIMAX_DATA_DIR", dataDir);
  vi.stubEnv("__MAVIS_RUNTIME_DATA_DIR", dataDir);
  vi.stubEnv("__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function storageRetention(raw: Record<string, unknown>) {
  return resolveConfigFromRaw(raw, dataDir).storageRetention;
}

describe("storageRetention", () => {
  it("is absent when config.yaml has no section or an empty one", () => {
    expect(storageRetention({})).toBeUndefined();
    expect(storageRetention({ storageRetention: null })).toBeUndefined();
    expect(storageRetention({ storageRetention: {} })).toEqual({});
  });

  it("keeps numbers as written so the runtime decides whether they are valid", () => {
    expect(
      storageRetention({
        storageRetention: { backgroundTasksDays: 14, turnDiffsDays: 2.5, logsDays: -1 },
      }),
    ).toEqual({ backgroundTasksDays: 14, turnDiffsDays: 2.5, logsDays: -1 });
  });

  it("marks values that are not numbers as invalid instead of dropping them", () => {
    const parsed = storageRetention({
      storageRetention: { historyMutationReceiptsHours: "24h", legacyHistoryDays: null },
    });

    expect(parsed?.historyMutationReceiptsHours).toBeNaN();
    expect(parsed?.legacyHistoryDays).toBeNaN();
    expect(parsed).not.toHaveProperty("turnDiffsDays");
  });

  it("marks every key invalid when the section is not a mapping", () => {
    const parsed = storageRetention({ storageRetention: "off" });

    expect(Object.keys(parsed ?? {})).toHaveLength(5);
    expect(Object.values(parsed ?? {}).every(Number.isNaN)).toBe(true);
  });
});
