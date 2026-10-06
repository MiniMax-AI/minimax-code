import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLegacyDataDirPath, getPrimaryDataDirPath, resolveDataDir } from "../src/data-dir.js";

const originalPlatform = process.platform;
let root: string;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}
function marker(dir: string, text = "synthetic-data"): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), text);
}
function readMarker(dir: string): string {
  return fs.readFileSync(path.join(dir, "config.yaml"), "utf8");
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-data-dir-"));
  setPlatform("linux");
  for (const key of ["XDG_DATA_HOME", "MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"]) vi.stubEnv(key, "");
});
afterEach(() => {
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Linux XDG directory selection", () => {
  it.each(["", "   ", "relative/data", "~/data"])("falls back for invalid XDG_DATA_HOME %j", (value) => {
    vi.stubEnv("XDG_DATA_HOME", value);
    expect(getPrimaryDataDirPath(root)).toBe(path.join(root, ".local", "share", "minimax"));
  });
  it("uses an absolute XDG path and preserves the profile suffix", () => {
    vi.stubEnv("XDG_DATA_HOME", path.join(root, "custom data"));
    expect(getPrimaryDataDirPath(root, "work")).toBe(path.join(root, "custom data", "minimax-work"));
    expect(getLegacyDataDirPath(root, "work")).toBe(path.join(root, ".mavis-work"));
  });
  it("initializes a fresh XDG directory and remains stable on repeated resolution", () => {
    const expected = path.join(root, ".local", "share", "minimax");
    expect(resolveDataDir({ homeDir: root })).toBe(expected);
    marker(expected);
    expect(resolveDataDir({ homeDir: root })).toBe(expected);
    expect(readMarker(expected)).toBe("synthetic-data");
    expect(fs.realpathSync(path.join(root, ".mavis"))).toBe(fs.realpathSync(expected));
  });
  it.each([null, "work"])("preserves existing .minimax data in place for profile %s", (profile) => {
    const previous = path.join(root, profile ? `.minimax-${profile}` : ".minimax");
    marker(previous);
    expect(getPrimaryDataDirPath(root, profile)).toBe(previous);
    expect(resolveDataDir({ homeDir: root, profile })).toBe(previous);
    expect(readMarker(previous)).toBe("synthetic-data");
    expect(fs.lstatSync(previous).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(root, ".local"))).toBe(false);
  });
  it("preserves .minimax when .mavis already points to it", () => {
    const previous = path.join(root, ".minimax");
    marker(previous);
    fs.symlinkSync(previous, path.join(root, ".mavis"), "dir");
    expect(resolveDataDir({ homeDir: root })).toBe(previous);
    expect(readMarker(previous)).toBe("synthetic-data");
    expect(readMarker(path.join(root, ".mavis"))).toBe("synthetic-data");
  });
  it("does not relocate an existing .minimax symlink target", () => {
    const external = path.join(root, "external");
    marker(external);
    fs.symlinkSync(external, path.join(root, ".minimax"), "dir");
    fs.symlinkSync(external, path.join(root, ".mavis"), "dir");
    expect(resolveDataDir({ homeDir: root })).toBe(path.join(root, ".minimax"));
    expect(readMarker(external)).toBe("synthetic-data");
    expect(readMarker(path.join(root, ".minimax"))).toBe("synthetic-data");
  });
  it("retains the existing .mavis to .minimax migration for older installations", () => {
    marker(path.join(root, ".mavis"));
    const expected = path.join(root, ".minimax");
    expect(resolveDataDir({ homeDir: root })).toBe(expected);
    expect(readMarker(expected)).toBe("synthetic-data");
    expect(fs.realpathSync(path.join(root, ".mavis"))).toBe(fs.realpathSync(expected));
  });
  it("prefers the existing installation when XDG also contains independent data", () => {
    const previous = path.join(root, ".minimax");
    const xdg = path.join(root, ".local", "share", "minimax");
    marker(previous, "previous");
    marker(xdg, "xdg");
    expect(resolveDataDir({ homeDir: root })).toBe(previous);
    expect(readMarker(previous)).toBe("previous");
    expect(readMarker(xdg)).toBe("xdg");
  });
  it("does not silently switch away from an inaccessible previous directory", () => {
    const previous = path.join(root, ".minimax");
    const lstatSync = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (args[0] === previous) throw Object.assign(new Error("synthetic access denied"), { code: "EACCES" });
      return lstatSync(...args);
    });
    expect(resolveDataDir({ homeDir: root })).toBe(previous);
    expect(fs.existsSync(path.join(root, ".local"))).toBe(false);
  });
  it("preserves a dangling previous symlink instead of selecting a new data store", () => {
    const previous = path.join(root, ".minimax");
    fs.symlinkSync(path.join(root, "unmounted"), previous, "dir");
    expect(resolveDataDir({ homeDir: root })).toBe(previous);
    expect(fs.readlinkSync(previous)).toBe(path.join(root, "unmounted"));
    expect(fs.existsSync(path.join(root, ".local"))).toBe(false);
  });
  it.each(["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"])("keeps explicit %s authoritative", async (key) => {
    const explicit = path.join(root, "explicit");
    vi.stubEnv(key, explicit);
    vi.stubEnv("XDG_DATA_HOME", path.join(root, "xdg"));
    const { getDataDir } = await import("../src/config.js");
    expect(getDataDir()).toBe(explicit);
  });
});

describe("other platforms", () => {
  it.each(["darwin", "win32"] as const)("preserves primary and legacy paths on %s", (platform) => {
    setPlatform(platform);
    vi.stubEnv("XDG_DATA_HOME", path.join(root, "xdg"));
    expect(getPrimaryDataDirPath(root)).toBe(path.join(root, ".minimax"));
    expect(getPrimaryDataDirPath(root, "work")).toBe(path.join(root, ".minimax-work"));
    expect(getLegacyDataDirPath(root)).toBe(path.join(root, ".mavis"));
  });
});
