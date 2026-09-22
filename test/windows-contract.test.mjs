import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { checkWindowsSourceLocation } from "../scripts/check-windows-source-location.mjs";
import { resolveWslPath } from "../packages/tui/src/host/wsl-path.js";

const windowsPath = String.raw`D:\Users\demo\Documents\Screen shots\截图.png`;

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
});
