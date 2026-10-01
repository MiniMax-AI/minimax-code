import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePrivateConfigFileSync } from "../src/private-config-file.js";

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "private-config-write-"));
  file = join(root, "config.yaml");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// These use the native filesystem on every OS, including Windows.
describe("private config writes", () => {
  it.each([false, true])(
    "creates a missing file (exclusive=%s)",
    (exclusive) => {
      writePrivateConfigFileSync(file, "logLevel: info\n", exclusive);
      expect(fs.readFileSync(file, "utf8")).toBe("logLevel: info\n");
      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    },
  );

  it.each(["logLevel: info\n", Buffer.from("logLevel: info\n")])(
    "replaces longer content without appending or retaining a suffix",
    (content) => {
      fs.writeFileSync(
        file,
        "logLevel: debug\n# old credentials and trailing data\n",
      );
      writePrivateConfigFileSync(file, content);
      expect(fs.readFileSync(file, "utf8")).toBe("logLevel: info\n");
    },
  );

  it("does not overwrite an existing file in exclusive mode", () => {
    fs.writeFileSync(file, "original");
    expect(() =>
      writePrivateConfigFileSync(file, "replacement", true),
    ).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });

  it.each(["fchmodSync", "ftruncateSync"] as const)(
    "closes the descriptor and stops writing when %s fails",
    (operation) => {
      fs.writeFileSync(file, "original");
      const failure = Object.assign(new Error("synthetic failure"), {
        code: "EPERM",
      });
      vi.spyOn(fs, operation).mockImplementation(() => {
        throw failure;
      });
      const write = vi.spyOn(fs, "writeFileSync");
      const close = vi.spyOn(fs, "closeSync");
      expect(() => writePrivateConfigFileSync(file, "replacement")).toThrow(
        failure,
      );
      expect(write).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(file, "utf8")).toBe("original");
    },
  );

  it("propagates a write failure and closes the descriptor", () => {
    const failure = new Error("synthetic write failure");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw failure;
    });
    const close = vi.spyOn(fs, "closeSync");
    expect(() => writePrivateConfigFileSync(file, "replacement")).toThrow(
      failure,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
