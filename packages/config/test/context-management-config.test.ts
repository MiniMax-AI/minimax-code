import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigFromRaw } from "../src/config.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(join(os.tmpdir(), "mcode-context-management-"));
  vi.stubEnv("MINIMAX_DATA_DIR", dataDir);
  vi.stubEnv("__MAVIS_RUNTIME_DATA_DIR", dataDir);
  vi.stubEnv("__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function contextManagement(raw: Record<string, unknown>) {
  return resolveConfigFromRaw(raw, dataDir).contextManagement;
}

describe("contextManagement.compactionTriggerAt", () => {
  it("is absent by default", () => {
    expect(contextManagement({})).not.toHaveProperty("compactionTriggerAt");
    expect(contextManagement({ contextManagement: {} })).not.toHaveProperty(
      "compactionTriggerAt",
    );
  });

  it.each([0.8, 300_000, 1.5, -1])(
    "keeps the number %s for runtime validation",
    (value) => {
      expect(
        contextManagement({ contextManagement: { compactionTriggerAt: value } }),
      ).toMatchObject({ compactionTriggerAt: value });
    },
  );

  it.each(["0.8", null, true, { ratio: 0.8 }])(
    "drops the non-number %j",
    (value) => {
      expect(
        contextManagement({ contextManagement: { compactionTriggerAt: value } }),
      ).not.toHaveProperty("compactionTriggerAt");
    },
  );

  it("does not disturb the sibling keys", () => {
    expect(
      contextManagement({
        contextManagement: {
          compactionTriggerAt: 0.5,
          cuMaxScreenshotsInContext: 3,
        },
      }),
    ).toEqual({
      disableSystemReminderModels: [],
      cuMaxScreenshotsInContext: 3,
      compactionTriggerAt: 0.5,
    });
  });
});
