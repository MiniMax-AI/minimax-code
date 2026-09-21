import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTuiExecInvocation } from "../../src/headless/invocation.js";
import { resolveWslPath } from "../../src/host/wsl-path.js";
import { resolveTuiAttachment } from "../../src/tui/features/composer/attachments.js";
import { TuiComposerDraft } from "../../src/tui/features/composer/draft.js";
import { isTuiTerminalImagePaste } from "../../src/tui/features/composer/terminal-image-paste.js";

const host = vi.hoisted(() => ({
  platform: vi.fn(() => "linux"),
  release: vi.fn(() => "6.18.33.2-microsoft-standard-WSL2"),
  executeFile: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: host.platform,
  release: host.release,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: host.executeFile,
  }),
}));

let workspaceDir: string;
let imagePath: string;
const windowsPath = String.raw`D:\Users\demo\Documents\Screen shots\截图.png`;

beforeEach(async () => {
  host.platform.mockReturnValue("linux");
  host.release.mockReturnValue("6.18.33.2-microsoft-standard-WSL2");
  host.executeFile.mockReset();
  vi.stubEnv("WSL_DISTRO_NAME", "");
  vi.stubEnv("WSL_INTEROP", "");
  vi.stubEnv("WSLENV", "");
  workspaceDir = await mkdtemp(join(tmpdir(), "mcode-wsl-path-"));
  imagePath = join(workspaceDir, "截图.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  host.executeFile.mockResolvedValue({ stdout: `${imagePath}\n`, stderr: "" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("WSL attachment paths", () => {
  it.each([
    windowsPath,
    `"${windowsPath}"`,
    `'${windowsPath}'`,
    windowsPath.replaceAll("\\", "/"),
  ])(
    "queues a Windows image path as an image placeholder: %s",
    async (reference) => {
      const placeholders = vi.fn();
      const draft = new TuiComposerDraft({
        workspaceDir,
        resolveAttachment: resolveTuiAttachment,
        append: vi.fn(),
        onChanged: vi.fn(),
        onAttachmentPlaceholdersChanged: placeholders,
      });
      expect(isTuiTerminalImagePaste(reference)).toBe(true);
      await draft.queueAttachment(reference, { source: "terminal-paste" });
      expect(draft.snapshot().attachments).toEqual([
        {
          type: "image",
          filePath: imagePath,
          fileName: "截图.png",
          mimeType: "image/png",
          sizeBytes: 4,
        },
      ]);
      expect(placeholders).toHaveBeenLastCalledWith([
        { id: imagePath, label: "[Image #1]" },
      ]);
      expect(host.executeFile).toHaveBeenCalledWith(
        "wslpath",
        ["-a", "-u", reference.replace(/^['"]|['"]$/gu, "")],
        expect.objectContaining({
          encoding: "utf8",
          timeout: 1_000,
          maxBuffer: 64 * 1024,
        }),
      );
    },
  );

  it("resolves headless --file through the same conversion before realpath", async () => {
    const invocation = await resolveTuiExecInvocation(
      "describe",
      { cwd: workspaceDir, file: [windowsPath] },
      async () => "",
    );
    expect(invocation.attachments).toEqual([
      {
        type: "image",
        filePath: await realpath(imagePath),
        fileName: "截图.png",
        mimeType: "image/png",
        sizeBytes: 4,
      },
    ]);
    expect(host.executeFile).toHaveBeenCalledOnce();
  });

  it.each(["WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV"])(
    "detects WSL via %s even without a Microsoft kernel name",
    async (name) => {
      host.release.mockReturnValue("custom-kernel");
      vi.stubEnv(name, "synthetic-wsl");
      await expect(resolveWslPath(windowsPath)).resolves.toBe(imagePath);
    },
  );

  it.each(["darwin", "win32", "linux"])(
    "preserves Windows path syntax on a non-WSL %s host",
    async (platform) => {
      host.platform.mockReturnValue(platform);
      host.release.mockReturnValue("generic-kernel");
      await expect(resolveWslPath(windowsPath)).resolves.toBe(windowsPath);
      expect(host.executeFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/mnt/d/Screen shots/截图.png",
    "/tmp/literal\\name.png",
    "//tmp/image.png",
    "image.png",
    "~/image.png",
    "D:relative.png",
  ])(
    "leaves native and relative paths unchanged in WSL: %s",
    async (reference) => {
      await expect(resolveWslPath(reference)).resolves.toBe(reference);
      expect(host.executeFile).not.toHaveBeenCalled();
    },
  );

  it("keeps native attachment resolution working in WSL without a subprocess", async () => {
    await expect(
      resolveTuiAttachment("截图.png", { workspaceDir }),
    ).resolves.toMatchObject({ filePath: imagePath });
    await expect(
      resolveTuiAttachment("~/截图.png", {
        workspaceDir,
        homeDir: workspaceDir,
      }),
    ).resolves.toMatchObject({ filePath: imagePath });
    expect(host.executeFile).not.toHaveBeenCalled();
  });

  it.each([
    String.raw`d:\Screen shots\$(touch marker);'截图'.png`,
    String.raw`\\server\share\截图.png`,
  ])("passes Windows paths as a literal argument: %s", async (reference) => {
    await expect(resolveWslPath(reference)).resolves.toBe(imagePath);
    expect(host.executeFile.mock.calls[0]?.slice(0, 2)).toEqual([
      "wslpath",
      ["-a", "-u", reference],
    ]);
    expect(host.executeFile.mock.calls[0]?.[2]).not.toHaveProperty("shell");
  });

  it("honors the converter output for custom mount roots and preserves trailing spaces", async () => {
    host.executeFile.mockResolvedValue({
      stdout: "/custom/windows/d/Screen shots/image.png \n",
    });
    await expect(resolveWslPath(windowsPath)).resolves.toBe(
      "/custom/windows/d/Screen shots/image.png ",
    );
  });

  it.each([
    "",
    "\n",
    "relative/image.png\n",
    "D:\\image.png\n",
    "/tmp/image.png\nextra\n",
    "/tmp/image\0.png\n",
  ])(
    "rejects invalid converter output instead of treating it as a local path: %j",
    async (stdout) => {
      host.executeFile.mockResolvedValue({ stdout });
      await expect(
        resolveTuiAttachment(windowsPath, { workspaceDir }),
      ).rejects.toThrow("Could not convert the Windows path with wslpath");
    },
  );

  it.each(["ENOENT", "EACCES", "ETIMEDOUT"])(
    "reports converter failure %s without falling back to a workspace filename",
    async (code) => {
      if (process.platform !== "win32")
        await writeFile(join(workspaceDir, windowsPath), "wrong image");
      host.executeFile.mockRejectedValue(
        Object.assign(new Error("converter failed"), { code }),
      );
      await expect(
        resolveTuiAttachment(windowsPath, {
          workspaceDir,
          source: "terminal-paste",
        }),
      ).rejects.toThrow("Use an accessible Linux path instead");
      await expect(
        resolveTuiExecInvocation(
          "describe",
          { cwd: workspaceDir, file: [windowsPath] },
          async () => "",
        ),
      ).rejects.toMatchObject({
        kind: "invocation",
        message: expect.stringContaining("wslpath"),
      });
    },
  );

  it("still rejects missing files and directories after conversion", async () => {
    host.executeFile.mockResolvedValue({
      stdout: `${join(workspaceDir, "missing.png")}\n`,
    });
    await expect(
      resolveTuiAttachment(windowsPath, { workspaceDir }),
    ).rejects.toThrow("ENOENT");
    host.executeFile.mockResolvedValue({ stdout: `${workspaceDir}\n` });
    await expect(
      resolveTuiAttachment(windowsPath, { workspaceDir }),
    ).rejects.toThrow("not a file");
  });

  it("preserves headless cancellation while converting a path", async () => {
    const controller = new AbortController();
    host.executeFile.mockImplementation(async (_file, _args, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("aborted");
    });
    await expect(
      resolveTuiExecInvocation(
        "describe",
        { cwd: workspaceDir, file: [windowsPath] },
        async () => "",
        controller.signal,
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });
});
