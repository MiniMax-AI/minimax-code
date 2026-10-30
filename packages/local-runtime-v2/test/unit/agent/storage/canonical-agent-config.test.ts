import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureLocalRuntimeLogging,
  flushLocalRuntimeLogging,
  logger,
  shutdownLocalRuntimeLogging,
} from "../../../../src/infra/logging/index.js";
import {
  AgentConfigError,
  assertSafeAgentAvatarDirectory,
  decodeAgentAvatarDataUrl,
  parseBuiltinCanonicalAgentMarkdown,
  parseCanonicalAgentMarkdown,
  readCanonicalAgentConfig,
  readSafeAgentAvatar,
  readStableAgentMarkdown,
  serializeBuiltinCanonicalAgentConfig,
  serializeCanonicalAgentConfig,
} from "../../../../src/service/agent/storage/canonical-agent-config.js";
import {
  hasCanonicalPatch,
  patchCanonicalMarkdown,
} from "../../../../src/service/agent/storage/canonical-agent-patch.js";

const cleanup: Array<() => Promise<void>> = [];
const DATA_DIR_SOURCE_ENV = "__MAVIS_RUNTIME_DATA_DIR_SOURCE";
const ORIGINAL_DATA_DIR_SOURCE = process.env[DATA_DIR_SOURCE_ENV];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  if (ORIGINAL_DATA_DIR_SOURCE === undefined)
    delete process.env[DATA_DIR_SOURCE_ENV];
  else process.env[DATA_DIR_SOURCE_ENV] = ORIGINAL_DATA_DIR_SOURCE;
});

describe("canonical Custom Agent config", () => {
  registerCanonicalConfigParsingTests();
  registerCanonicalConfigCapabilityTests();
});

function registerCanonicalConfigParsingTests(): void {
  it("accepts the minimal frontmatter and preserves a body as the Agent-owned prompt", () => {
    expect(
      parseCanonicalAgentMarkdown(
        "---\nname: researcher\ndescription: Evidence first.\n---\n\nUse primary sources.\n",
        "researcher",
      ),
    ).toMatchObject({
      name: "researcher",
      description: "Evidence first.",
      systemPrompt: "Use primary sources.\n",
      diagnostics: [],
    });
  });

  it("preserves CRLF prompt bytes and whitespace after the canonical delimiter", () => {
    const systemPrompt =
      "\r\n  Keep leading spaces  \r\n\r\nKeep trailing spaces  \r\n";
    const raw = `\uFEFF---\r\nname: researcher\r\ndescription: Evidence first.\r\n---\r\n\r\n${systemPrompt}`;

    expect(parseCanonicalAgentMarkdown(raw, "researcher").systemPrompt).toBe(
      systemPrompt,
    );
  });

  it("accepts only the legacy unquoted description colon spelling", () => {
    const legacy =
      "---\nname: psd-localizer\ndescription: PSD localizer: preserve layers\n---\n\nKeep layers.\n";
    expect(parseCanonicalAgentMarkdown(legacy, "psd-localizer")).toMatchObject({
      description: "PSD localizer: preserve layers",
      systemPrompt: "Keep layers.\n",
    });
    expect(
      parseCanonicalAgentMarkdown(
        legacy.replaceAll("\n", "\r\n"),
        "psd-localizer",
      ),
    ).toMatchObject({
      description: "PSD localizer: preserve layers",
    });

    let invalid: unknown;
    try {
      parseCanonicalAgentMarkdown(
        "---\nname: psd-localizer\ndescription: PSD localizer: preserve layers\ntools: Read\n---\n",
        "psd-localizer",
      );
    } catch (error) {
      invalid = error;
    }
    expect(invalid).toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      field: "tools",
    });

    let malformed: unknown;
    try {
      parseCanonicalAgentMarkdown(
        "---\nname: psd-localizer: invalid\ndescription: PSD localizer: preserve layers\n---\n",
        "psd-localizer",
      );
    } catch (error) {
      malformed = error;
    }
    expect(malformed).toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      field: "frontmatter",
    });

    let duplicate: unknown;
    try {
      parseCanonicalAgentMarkdown(
        "---\nname: psd-localizer\ndescription: PSD localizer: preserve layers\nname: duplicate\n---\n",
        "psd-localizer",
      );
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      field: "frontmatter",
    });
  });

  it("keeps route ownership with the directory name, normalizes blank workspace, and diagnoses unknown fields", () => {
    const parsed = parseCanonicalAgentMarkdown(
      '---\nname: portable-name\ndescription: Evidence first.\nunknownCompatibilityKey: keep-me\nx-mavis:\n  displayName: Portable display\n  avatar: ./avatar.png\n  defaultWorkspaceDir: "   "\n  unknownMavisKey: keep-me\n---\n',
      "researcher",
    );

    expect(parsed).toMatchObject({
      name: "portable-name",
      description: "Evidence first.",
      xMavis: { displayName: "Portable display", avatar: "./avatar.png" },
    });
    expect(parsed.xMavis).not.toHaveProperty("defaultWorkspaceDir");
    expect(parsed.diagnostics).toEqual([
      { code: "agent_name_mismatch", field: "name" },
      { code: "unsupported_agent_field", field: "unknownCompatibilityKey" },
      { code: "unsupported_agent_field", field: "x-mavis.unknownMavisKey" },
    ]);
  });

  it.each(["on", "off"] as const)(
    "reads an unquoted MiniMax M3 thinking mode %s as a string and preserves it through serialization",
    (effort) => {
      const parsed = parseCanonicalAgentMarkdown(
        `---\nname: researcher\ndescription: Evidence first.\nmodel: minimax/MiniMax-M3\neffort: ${effort}\n---\n`,
        "researcher",
      );
      expect(parsed.model).toBe("minimax/MiniMax-M3");
      expect(parsed.effort).toBe(effort);
      expect(typeof parsed.effort).toBe("string");

      const serialized = serializeCanonicalAgentConfig({
        config: {
          name: parsed.name,
          description: parsed.description,
          model: parsed.model,
          effort: parsed.effort,
          systemPrompt: parsed.systemPrompt,
        },
      });
      expect(
        parseCanonicalAgentMarkdown(serialized, "researcher"),
      ).toMatchObject({
        model: "minimax/MiniMax-M3",
        effort,
      });
    },
  );

  it.each(['custom_provider:x/acc-loomy/qwen-3.8-max', 'openrouter/qwen/qwen3'])(
    'keeps a model id containing a slash (%s) through serialization',
    (model) => {
      const markdown = serializeCanonicalAgentConfig({
        config: { name: 'researcher', description: 'Evidence first.', model, systemPrompt: '' },
      });
      expect(markdown).toContain(`model: ${model}\n`);
      expect(parseCanonicalAgentMarkdown(markdown, 'researcher').model).toBe(model);
    },
  );

  it.each([
    ["missing description", "---\nname: researcher\n---\n", "description"],
    [
      "invalid name",
      "---\nname: [researcher]\ndescription: desc\n---\n",
      "name",
    ],
    [
      "invalid description",
      "---\nname: researcher\ndescription: [desc]\n---\n",
      "description",
    ],
    [
      "invalid known array",
      "---\nname: researcher\ndescription: desc\ntools: Read\n---\n",
      "tools",
    ],
    [
      "invalid model shape",
      "---\nname: researcher\ndescription: desc\nmodel: MiniMax-M3\n---\n",
      "model",
    ],
    [
      "model without provider",
      "---\nname: researcher\ndescription: desc\nmodel: /model\n---\n",
      "model",
    ],
    [
      "model without model id",
      "---\nname: researcher\ndescription: desc\nmodel: provider/\n---\n",
      "model",
    ],
    [
      "model with whitespace",
      "---\nname: researcher\ndescription: desc\nmodel: provider/model id\n---\n",
      "model",
    ],
    [
      "invalid effort",
      "---\nname: researcher\ndescription: desc\neffort: [high]\n---\n",
      "effort",
    ],
    [
      "invalid disallowed tools",
      "---\nname: researcher\ndescription: desc\ndisallowedTools: Write\n---\n",
      "disallowedTools",
    ],
    [
      "invalid MCP servers",
      "---\nname: researcher\ndescription: desc\nmcpServers: local\n---\n",
      "mcpServers",
    ],
    [
      "invalid skills",
      "---\nname: researcher\ndescription: desc\nskills: research\n---\n",
      "skills",
    ],
    [
      "invalid x-mavis display name",
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  displayName: [display]\n---\n",
      "displayName",
    ],
    [
      "invalid x-mavis avatar",
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: 42\n---\n",
      "avatar",
    ],
    [
      "invalid x-mavis limit",
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  contextWindow: -1\n---\n",
      "contextWindow",
    ],
    [
      "invalid x-mavis output limit",
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  maxOutputTokens: zero\n---\n",
      "maxOutputTokens",
    ],
    [
      "invalid x-mavis extension skills",
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  extensionSkills: research\n---\n",
      "extensionSkills",
    ],
    [
      "relative workspace",
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  defaultWorkspaceDir: relative/workspace\n---\n",
      "x-mavis.defaultWorkspaceDir",
    ],
  ])(
    "fails closed for %s with a field-level diagnostic",
    (_label, markdown, field) => {
      let thrown: unknown;
      try {
        parseCanonicalAgentMarkdown(markdown, "researcher");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AgentConfigError);
      expect(thrown).toMatchObject({ code: "AGENT_CONFIG_INVALID", field });
    },
  );
}

function registerCanonicalConfigCapabilityTests(): void {
  it("fails closed for a frontmatter tree deeper than the bounded parser limit", () => {
    const nested = Array.from(
      { length: 18 },
      (_, index) => `${"  ".repeat(index)}next:`,
    ).join("\n");
    let thrown: unknown;
    try {
      parseCanonicalAgentMarkdown(
        `---\nname: researcher\ndescription: desc\nextra:\n${nested}\n${"  ".repeat(18)}value: true\n---\n`,
        "researcher",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      field: "frontmatter",
    });
  });

  it("normalizes YAML alias expansion failures into the stable config diagnostic", () => {
    const aliases = Array.from(
      { length: 33 },
      (_, index) => `copy${index}: *base`,
    ).join("\n");
    let thrown: unknown;
    try {
      parseCanonicalAgentMarkdown(
        `---\nname: researcher\ndescription: desc\nbase: &base [one, two]\n${aliases}\n---\n`,
        "researcher",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      field: "frontmatter",
    });
  });

  it.each([
    ["a scalar frontmatter document", "---\nplain text\n---\n", "frontmatter"],
    [
      "a non-mapping x-mavis section",
      "---\nname: researcher\ndescription: desc\nx-mavis: []\n---\n",
      "x-mavis",
    ],
    [
      "a blank required value",
      '---\nname: " "\ndescription: desc\n---\n',
      "name",
    ],
  ])("rejects %s", (_label, markdown, field) => {
    expect(() => parseCanonicalAgentMarkdown(markdown, "researcher")).toThrow(
      expect.objectContaining({ code: "AGENT_CONFIG_INVALID", field }),
    );
  });

  it("distinguishes omitted capability selectors from explicit empty and nonempty arrays", () => {
    const inherited = parseCanonicalAgentMarkdown(
      "---\nname: researcher\ndescription: desc\n---\n",
      "researcher",
    );
    const disabled = parseCanonicalAgentMarkdown(
      "---\nname: researcher\ndescription: desc\ntools: []\ndisallowedTools: []\nmcpServers: []\nskills: []\nx-mavis:\n  extensionSkills: []\n---\n",
      "researcher",
    );
    const selected = parseCanonicalAgentMarkdown(
      "---\nname: researcher\ndescription: desc\ntools: [Read]\ndisallowedTools: [Write]\nmcpServers: [local-mcp]\nskills: [research]\nx-mavis:\n  extensionSkills: [extension-research]\n---\n",
      "researcher",
    );

    expect(inherited).not.toHaveProperty("tools");
    expect(inherited).not.toHaveProperty("disallowedTools");
    expect(inherited).not.toHaveProperty("mcpServers");
    expect(inherited).not.toHaveProperty("skills");
    expect(inherited.xMavis).toBeUndefined();
    expect(disabled.tools).toEqual([]);
    expect(disabled.disallowedTools).toEqual([]);
    expect(disabled.mcpServers).toEqual([]);
    expect(disabled.skills).toEqual([]);
    expect(disabled.xMavis?.extensionSkills).toEqual([]);
    expect(selected).toMatchObject({
      tools: ["Read"],
      disallowedTools: ["Write"],
      mcpServers: ["local-mcp"],
      skills: ["research"],
      xMavis: { extensionSkills: ["extension-research"] },
    });
  });
}

describe("managed Builtin Agent config", () => {
  it("serializes feature policy without adding it to the Custom Agent contract", () => {
    const serialized = serializeBuiltinCanonicalAgentConfig({
      config: {
        name: "explore",
        description: "Explore",
        features: { mavis: false, delegation: false, webSearch: true },
        systemPrompt: "Builtin prompt",
      },
    });

    expect(serialized).toContain(
      "features:\n  mavis: false\n  delegation: false\n  webSearch: true",
    );
    expect(
      parseBuiltinCanonicalAgentMarkdown(serialized, "explore"),
    ).toMatchObject({
      features: { mavis: false, delegation: false, webSearch: true },
    });
    const custom = parseCanonicalAgentMarkdown(serialized, "explore");
    expect(custom).not.toHaveProperty("features");
    expect(custom.diagnostics).toContainEqual({
      code: "unsupported_agent_field",
      field: "features",
    });
  });

  it("keeps a partial legacy policy readable but rejects it for a managed write", () => {
    const legacy =
      "---\nname: explore\ndescription: Explore\nmodel: provider/model\nfeatures:\n  webSearch: true\n---\n";

    expect(parseBuiltinCanonicalAgentMarkdown(legacy, "explore")).toMatchObject(
      {
        config: { model: "provider/model" },
      },
    );
    expect(() =>
      parseBuiltinCanonicalAgentMarkdown(legacy, "explore", {
        requireFeaturePolicy: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "AGENT_CONFIG_INVALID",
        field: "features.mavis",
      }),
    );
  });
});

describe("canonical Custom Agent profile patching", () => {
  it("preserves CRLF framing and a terminal closing marker while applying profile fields", () => {
    const source = [
      "---",
      "name: researcher",
      "description: Before",
      "x-mavis:",
      "  displayName: Before Name",
      "  avatar: ./before.png",
      "---",
    ].join("\r\n");

    const rendered = patchCanonicalMarkdown(
      source,
      "researcher",
      {
        description: "  After  ",
        displayName: null,
        avatar: undefined,
      },
      undefined,
    );

    expect(rendered.startsWith("---\r\n")).toBe(true);
    expect(rendered.endsWith("\r\n---")).toBe(true);
    expect(parseCanonicalAgentMarkdown(rendered, "researcher")).toMatchObject({
      description: "After",
    });
    expect(
      parseCanonicalAgentMarkdown(rendered, "researcher").xMavis,
    ).toBeUndefined();
  });

  it("keeps the raw prompt suffix when patching profile fields", () => {
    const systemPrompt =
      "\r\n  Keep leading spaces  \r\n\r\nKeep trailing spaces  \r\n";
    const source = `---\r\nname: researcher\r\ndescription: Before\r\n---\r\n\r\n${systemPrompt}`;

    const rendered = patchCanonicalMarkdown(
      source,
      "researcher",
      { description: "After" },
      undefined,
    );

    expect(rendered.endsWith(`---\r\n\r\n${systemPrompt}`)).toBe(true);
    expect(
      parseCanonicalAgentMarkdown(rendered, "researcher").systemPrompt,
    ).toBe(systemPrompt);
  });

  it("keeps the existing avatar until a staged local reference is available", () => {
    const source =
      "---\nname: researcher\ndescription: Before\nx-mavis:\n  avatar: ./before.png\n---\nBody\n";

    const rendered = patchCanonicalMarkdown(
      source,
      "researcher",
      { avatar: "data:image/png;base64,staged-elsewhere" },
      undefined,
    );

    expect(
      parseCanonicalAgentMarkdown(rendered, "researcher").xMavis?.avatar,
    ).toBe("./before.png");
    expect(rendered.endsWith("Body\n")).toBe(true);
  });

  it.each([
    ["missing opening marker", "name: researcher\ndescription: Before\n---\n"],
    ["missing closing marker", "---\nname: researcher\ndescription: Before\n"],
    [
      "duplicate YAML key",
      "---\nname: researcher\nname: duplicate\ndescription: Before\n---\n",
    ],
  ])("rejects %s before replacing the canonical bytes", (_label, source) => {
    expect(() =>
      patchCanonicalMarkdown(
        source,
        "researcher",
        { description: "After" },
        undefined,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "AGENT_CONFIG_INVALID",
        field: "frontmatter",
      }),
    );
  });

  it.each([
    [{ description: null }, "description"],
    [{ displayName: undefined }, "x-mavis.displayName"],
  ] as const)("rejects an explicitly blank profile field", (patch, field) => {
    const source = "---\nname: researcher\ndescription: Before\n---\n";

    expect(() =>
      patchCanonicalMarkdown(source, "researcher", patch, undefined),
    ).toThrow(expect.objectContaining({ code: "AGENT_CONFIG_INVALID", field }));
  });

  it("distinguishes an omitted profile patch from an explicitly supplied field", () => {
    expect(hasCanonicalPatch({})).toBe(false);
    expect(hasCanonicalPatch({ avatar: undefined })).toBe(true);
  });
});

describe("canonical Custom Agent file safety", () => {
  it("rejects a requested canonical filename that escapes the Agent directory", async () => {
    const agentDir = await createAgentDir();

    await expect(
      readStableAgentMarkdown({
        agentDir,
        routeName: "researcher",
        fileName: "../agent.md",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_INVALID", field: "file" });
  });

  it("fails closed for invalid UTF-8 instead of returning a replacement-character source", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-invalid-utf8-"),
    );
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const agentDir = join(dataDir, "agents", "researcher");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "agent.md"),
      Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]),
    );

    await expect(
      readStableAgentMarkdown({
        agentDir,
        routeName: "researcher",
        trustedRoot: dataDir,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      field: "agent.md",
    });
  });

  it("strictly decodes bounded Desktop image data URLs without accepting a MIME mismatch", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    png.copy(oversized);

    expect(decodeAgentAvatarDataUrl(dataUrl)).toEqual({
      bytes: png,
      extension: ".png",
    });
    expect(() =>
      decodeAgentAvatarDataUrl("data:image/png;base64,not-base64"),
    ).toThrow(AgentConfigError);
    expect(() =>
      decodeAgentAvatarDataUrl(
        `data:image/jpeg;base64,${png.toString("base64")}`,
      ),
    ).toThrow(AgentConfigError);
    expect(() =>
      decodeAgentAvatarDataUrl("https://example.invalid/avatar.png"),
    ).toThrow(AgentConfigError);
    expect(() =>
      decodeAgentAvatarDataUrl(
        `data:image/png;base64,${oversized.toString("base64")}`,
      ),
    ).toThrow(AgentConfigError);
    expect(() => decodeAgentAvatarDataUrl("data:image/png;base64,AAA")).toThrow(
      AgentConfigError,
    );

    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
    const gif = Buffer.from("GIF89a", "ascii");
    const webp = Buffer.from("RIFF0000WEBP", "ascii");
    expect(
      decodeAgentAvatarDataUrl(
        `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      ),
    ).toEqual({
      bytes: jpeg,
      extension: ".jpg",
    });
    expect(
      decodeAgentAvatarDataUrl(
        `data:image/gif;base64,${gif.toString("base64")}`,
      ),
    ).toEqual({
      bytes: gif,
      extension: ".gif",
    });
    expect(
      decodeAgentAvatarDataUrl(
        `data:image/webp;base64,${webp.toString("base64")}`,
      ),
    ).toEqual({
      bytes: webp,
      extension: ".webp",
    });
  });

  it("rejects missing, escaping, non-file, and malformed local avatar targets", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-avatar-guards-"),
    );
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const agentDir = join(dataDir, "agents", "researcher");
    await mkdir(agentDir, { recursive: true });

    await expect(
      assertSafeAgentAvatarDirectory(
        join(dataDir, "agents", "missing"),
        dataDir,
      ),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_AVATAR_INVALID" });
    await expect(
      assertSafeAgentAvatarDirectory(join(dataDir, "..", "outside"), dataDir),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_AVATAR_INVALID" });

    await mkdir(join(agentDir, "folder.png"));
    await expect(
      readSafeAgentAvatar(agentDir, "./folder.png", dataDir),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_AVATAR_INVALID",
    });

    await writeFile(join(agentDir, "nested"), "not a directory");
    await expect(
      readSafeAgentAvatar(agentDir, "./nested/avatar.png", dataDir),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_AVATAR_INVALID",
    });

    await writeFile(join(agentDir, "invalid.jpg"), Buffer.from("not an image"));
    await expect(
      readSafeAgentAvatar(agentDir, "./invalid.jpg", dataDir),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_AVATAR_INVALID",
    });
  });

  it("reads an avatar below a linked Desktop agents root", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-linked-root-"),
    );
    const outsideDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-linked-root-outside-"),
    );
    cleanup.push(
      () => rm(outsideDir, { recursive: true, force: true }),
      () => rm(dataDir, { recursive: true, force: true }),
    );
    const externalAgentDir = join(outsideDir, "agents", "researcher");
    await mkdir(externalAgentDir, { recursive: true });
    await writeFile(
      join(externalAgentDir, "avatar.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await writeFile(
      join(externalAgentDir, "agent.md"),
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: ./avatar.png\n---\n",
    );
    await symlink(join(outsideDir, "agents"), join(dataDir, "agents"));

    await expect(
      readCanonicalAgentConfig({
        agentDir: join(dataDir, "agents", "researcher"),
        routeName: "researcher",
        trustedRoot: dataDir,
      }),
    ).resolves.toMatchObject({
      name: "researcher",
      xMavis: { avatar: "./avatar.png" },
    });
  });
});

describe("canonical Custom Agent avatar safety", () => {
  it("reads a supported regular avatar but rejects path escapes and symlinks", async () => {
    const agentDir = await createAgentDir();
    await writeFile(
      join(agentDir, "avatar.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await writeFile(
      join(agentDir, "agent.md"),
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: ./avatar.png\n---\n",
    );

    await expect(
      readCanonicalAgentConfig({ agentDir, routeName: "researcher" }),
    ).resolves.toMatchObject({
      xMavis: { avatar: "./avatar.png" },
    });

    await writeFile(
      join(agentDir, "agent.md"),
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: https://example.invalid/avatar.png\n---\n",
    );
    await expect(
      readCanonicalAgentConfig({ agentDir, routeName: "researcher" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_AVATAR_INVALID",
      field: "x-mavis.avatar",
    });

    await writeFile(
      join(agentDir, "agent.md"),
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: ../avatar.png\n---\n",
    );
    await expect(
      readCanonicalAgentConfig({ agentDir, routeName: "researcher" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_AVATAR_INVALID",
    });

    await symlink(join(agentDir, "avatar.png"), join(agentDir, "linked.png"));
    await writeFile(
      join(agentDir, "agent.md"),
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: ./linked.png\n---\n",
    );
    await expect(
      readCanonicalAgentConfig({ agentDir, routeName: "researcher" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_AVATAR_INVALID",
    });

    await writeFile(
      join(agentDir, "agent.md"),
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: ./avatar.png\n---\n",
    );
    const linkedAgentDir = join(agentDir, "..", "linked-researcher");
    await symlink(agentDir, linkedAgentDir);
    await expect(
      readCanonicalAgentConfig({
        agentDir: linkedAgentDir,
        routeName: "researcher",
      }),
    ).resolves.toMatchObject({ name: "researcher" });

    const outsideDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-avatar-outside-"),
    );
    cleanup.push(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(
      join(outsideDir, "avatar.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await symlink(outsideDir, join(agentDir, "nested"));
    await writeFile(
      join(agentDir, "agent.md"),
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: ./nested/avatar.png\n---\n",
    );
    await expect(
      readCanonicalAgentConfig({ agentDir, routeName: "researcher" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_AVATAR_INVALID",
    });
  });

  it("accepts a 10 MiB GIF data URL and reads the same bytes from the avatar file", async () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    bytes.write("GIF89a");
    const decoded = decodeAgentAvatarDataUrl(
      `data:image/gif;base64,${bytes.toString("base64")}`,
    );
    expect(decoded.bytes.equals(bytes)).toBe(true);
    const agentDir = await createAgentDir();
    await writeFile(join(agentDir, "avatar.gif"), decoded.bytes);
    const read = await readSafeAgentAvatar(agentDir, "./avatar.gif");
    expect(read.bytes.equals(bytes)).toBe(true);
  });

  it("bounds avatar reads before loading an arbitrarily large local image", async () => {
    const agentDir = await createAgentDir();
    await writeFile(
      join(agentDir, "avatar.png"),
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.alloc(10 * 1024 * 1024),
      ]),
    );
    await writeFile(
      join(agentDir, "agent.md"),
      "---\nname: researcher\ndescription: desc\nx-mavis:\n  avatar: ./avatar.png\n---\n",
    );

    await expect(
      readCanonicalAgentConfig({ agentDir, routeName: "researcher" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_AVATAR_INVALID",
      field: "x-mavis.avatar",
    });
  });

  it("serializes a complete canonical file without introducing legacy assets", () => {
    expect(
      serializeCanonicalAgentConfig({
        config: {
          name: "researcher",
          description: "Evidence first.",
          tools: [],
          xMavis: { defaultWorkspaceDir: "/workspace/researcher" },
          systemPrompt: "Use primary sources.",
        },
      }),
    ).toBe(
      "---\nname: researcher\ndescription: Evidence first.\ntools: []\nx-mavis:\n  defaultWorkspaceDir: /workspace/researcher\n---\n\nUse primary sources.",
    );
  });

  it("serializes prompt whitespace without normalizing line endings or appending a newline", () => {
    const systemPrompt =
      "\n\n  Keep leading spaces  \r\n\r\nKeep trailing spaces  \n\n";
    const serialized = serializeCanonicalAgentConfig({
      config: {
        name: "researcher",
        description: "Evidence first.",
        systemPrompt,
      },
    });

    expect(serialized.endsWith(`---\n\n${systemPrompt}`)).toBe(true);
    const parsed = parseCanonicalAgentMarkdown(serialized, "researcher");
    expect(parsed.systemPrompt).toBe(systemPrompt);
    const serializedAgain = serializeCanonicalAgentConfig({
      config: {
        name: parsed.name,
        description: parsed.description,
        systemPrompt: parsed.systemPrompt,
      },
    });
    expect(serializedAgain).toBe(serialized);

    const whitespaceOnly = "\t \r\n  ";
    const whitespaceOnlySerialized = serializeCanonicalAgentConfig({
      config: {
        name: "whitespace-only",
        description: "Whitespace only",
        systemPrompt: whitespaceOnly,
      },
    });
    expect(
      parseCanonicalAgentMarkdown(whitespaceOnlySerialized, "whitespace-only")
        .systemPrompt,
    ).toBe(whitespaceOnly);
  });

  it("serializes every x-mavis field while omitting an explicitly empty extension object", () => {
    const complete = serializeCanonicalAgentConfig({
      config: {
        name: "researcher",
        description: "Evidence first.",
        xMavis: {
          displayName: "Researcher",
          avatar: "./avatar.png",
          contextWindow: 64_000,
          maxOutputTokens: 4_096,
          extensionSkills: [],
        },
        systemPrompt: "",
      },
    });
    expect(complete).toContain("extensionSkills: []");

    expect(
      serializeCanonicalAgentConfig({
        config: {
          name: "minimal",
          description: "Minimal",
          xMavis: {},
          systemPrompt: "",
        },
      }),
    ).not.toContain("x-mavis");
  });
});

describe("canonical Agent directory safety", () => {
  it("follows linked Agent-directory segments and records their targets", async () => {
    process.env[DATA_DIR_SOURCE_ENV] = "mavis_env";
    const parentDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-linked-config-"),
    );
    const outsideDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-linked-config-outside-"),
    );
    cleanup.push(
      () => rm(outsideDir, { recursive: true, force: true }),
      () => rm(parentDir, { recursive: true, force: true }),
    );
    const markdown = "---\nname: researcher\ndescription: desc\n---\nPrompt\n";
    const warnSpy = vi.spyOn(logger, "warn");

    const minimaxRoot = join(parentDir, ".minimax-profile");
    const mavisRoot = join(parentDir, ".mavis-profile");
    await mkdir(join(minimaxRoot, "agents", "researcher"), { recursive: true });
    await writeFile(
      join(minimaxRoot, "agents", "researcher", "agent.md"),
      markdown,
    );
    await symlink(minimaxRoot, mavisRoot);

    await expect(
      readCanonicalAgentConfig({
        agentDir: join(mavisRoot, "agents", "researcher"),
        routeName: "researcher",
        trustedRoot: mavisRoot,
      }),
    ).resolves.toMatchObject({ name: "researcher" });

    const agentsRoot = join(parentDir, ".minimax-agents");
    const agentsTarget = join(outsideDir, "agents-target");
    await mkdir(agentsRoot, { recursive: true });
    await mkdir(join(agentsTarget, "researcher"), { recursive: true });
    await writeFile(join(agentsTarget, "researcher", "agent.md"), markdown);
    await symlink(agentsTarget, join(agentsRoot, "agents"));

    await expect(
      readCanonicalAgentConfig({
        agentDir: join(agentsRoot, "agents", "researcher"),
        routeName: "researcher",
        trustedRoot: agentsRoot,
      }),
    ).resolves.toMatchObject({ name: "researcher" });

    const builtinRoot = join(parentDir, ".minimax-builtin");
    const builtinTarget = join(outsideDir, "builtin-target");
    await mkdir(join(builtinRoot, "agents"), { recursive: true });
    await mkdir(join(builtinTarget, "explore"), { recursive: true });
    await writeFile(join(builtinTarget, "explore", "agent.md"), markdown);
    await symlink(builtinTarget, join(builtinRoot, "agents", ".builtin"));
    await expect(
      readCanonicalAgentConfig({
        agentDir: join(builtinRoot, "agents", ".builtin", "explore"),
        routeName: "researcher",
        trustedRoot: builtinRoot,
      }),
    ).resolves.toMatchObject({ name: "researcher" });

    const agentRoot = join(parentDir, ".minimax-agent");
    const agentTarget = join(outsideDir, "agent-target");
    await mkdir(join(agentRoot, "agents"), { recursive: true });
    await mkdir(agentTarget, { recursive: true });
    await writeFile(join(agentTarget, "agent.md"), markdown);
    await symlink(agentTarget, join(agentRoot, "agents", "researcher"));
    await expect(
      readCanonicalAgentConfig({
        agentDir: join(agentRoot, "agents", "researcher"),
        routeName: "researcher",
        trustedRoot: agentRoot,
      }),
    ).resolves.toMatchObject({ name: "researcher" });

    const insideRoot = join(parentDir, ".minimax-inside");
    const insideTarget = join(insideRoot, "managed-agent");
    await mkdir(join(insideRoot, "agents"), { recursive: true });
    await mkdir(insideTarget, { recursive: true });
    await writeFile(join(insideTarget, "agent.md"), markdown);
    await symlink(insideTarget, join(insideRoot, "agents", "researcher"));
    await expect(
      readCanonicalAgentConfig({
        agentDir: join(insideRoot, "agents", "researcher"),
        routeName: "researcher",
        trustedRoot: insideRoot,
      }),
    ).resolves.toMatchObject({ name: "researcher" });

    const nestedRoot = join(parentDir, ".minimax-nested");
    const nestedTarget = join(outsideDir, "nested-target");
    const nestedLink = join(
      nestedRoot,
      "agents",
      "researcher",
      "linked-directory",
    );
    await mkdir(join(nestedRoot, "agents", "researcher"), { recursive: true });
    await mkdir(nestedTarget, { recursive: true });
    await writeFile(join(nestedTarget, "agent.md"), markdown);
    await symlink(nestedTarget, nestedLink);
    await expect(
      readCanonicalAgentConfig({
        agentDir: nestedLink,
        routeName: "researcher",
        trustedRoot: nestedRoot,
      }),
    ).resolves.toMatchObject({ name: "researcher" });

    expect(warnSpy).toHaveBeenCalledWith(
      {
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "data_dir",
        logical_link_path: mavisRoot,
        readlink_raw_target: minimaxRoot,
        realpath_resolved_target: await realpath(minimaxRoot),
        resolved_target_kind: "directory",
        target_scope: "expected_default_target",
        root_kind: ".mavis",
      },
      "Following linked Agent directory",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      {
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "agents",
        logical_link_path: join(agentsRoot, "agents"),
        readlink_raw_target: agentsTarget,
        realpath_resolved_target: await realpath(agentsTarget),
        resolved_target_kind: "directory",
        target_scope: "data_dir_outside",
        root_kind: ".minimax",
      },
      "Following linked Agent directory",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      {
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "builtin",
        logical_link_path: join(builtinRoot, "agents", ".builtin"),
        readlink_raw_target: builtinTarget,
        realpath_resolved_target: await realpath(builtinTarget),
        resolved_target_kind: "directory",
        target_scope: "data_dir_outside",
        root_kind: ".minimax",
      },
      "Following linked Agent directory",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      {
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "agent",
        logical_link_path: join(agentRoot, "agents", "researcher"),
        readlink_raw_target: agentTarget,
        realpath_resolved_target: await realpath(agentTarget),
        resolved_target_kind: "directory",
        target_scope: "data_dir_outside",
        root_kind: ".minimax",
      },
      "Following linked Agent directory",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      {
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "agent",
        logical_link_path: join(insideRoot, "agents", "researcher"),
        readlink_raw_target: insideTarget,
        realpath_resolved_target: await realpath(insideTarget),
        resolved_target_kind: "directory",
        target_scope: "data_dir_inside",
        root_kind: ".minimax",
      },
      "Following linked Agent directory",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      {
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "nested",
        logical_link_path: nestedLink,
        readlink_raw_target: nestedTarget,
        realpath_resolved_target: await realpath(nestedTarget),
        resolved_target_kind: "directory",
        target_scope: "data_dir_outside",
        root_kind: ".minimax",
      },
      "Following linked Agent directory",
    );
  });
});

describe("canonical Agent directory safety", () => {
  it("logs each logical link target once across stable reads", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-link-dedup-"),
    );
    const targetDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-link-dedup-target-"),
    );
    cleanup.push(
      () => rm(targetDir, { recursive: true, force: true }),
      () => rm(dataDir, { recursive: true, force: true }),
    );
    await mkdir(join(targetDir, "researcher"), { recursive: true });
    await writeFile(
      join(targetDir, "researcher", "agent.md"),
      "---\nname: researcher\ndescription: desc\n---\nPrompt\n",
    );
    await symlink(targetDir, join(dataDir, "agents"));
    const warnSpy = vi.spyOn(logger, "warn");
    const input = {
      agentDir: join(dataDir, "agents", "researcher"),
      routeName: "researcher",
      trustedRoot: dataDir,
    };

    await expect(readCanonicalAgentConfig(input)).resolves.toMatchObject({
      name: "researcher",
    });
    await expect(readCanonicalAgentConfig(input)).resolves.toMatchObject({
      name: "researcher",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent_directory_link_followed",
        logical_link_path: join(dataDir, "agents"),
        realpath_resolved_target: await realpath(targetDir),
        resolved_target_kind: "directory",
      }),
      "Following linked Agent directory",
    );
  });

  it("persists a directory-link warning in the local-runtime disk log", async () => {
    process.env[DATA_DIR_SOURCE_ENV] = "mavis_env";
    const dataDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-persistent-link-"),
    );
    const targetDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-persistent-target-"),
    );
    const logsDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-persistent-logs-"),
    );
    cleanup.push(
      () => rm(logsDir, { recursive: true, force: true }),
      () => rm(targetDir, { recursive: true, force: true }),
      () => rm(dataDir, { recursive: true, force: true }),
    );
    const logicalLink = join(dataDir, "agents");
    await mkdir(join(targetDir, "researcher"), { recursive: true });
    await writeFile(
      join(targetDir, "researcher", "agent.md"),
      "---\nname: researcher\ndescription: desc\n---\nPrompt\n",
    );
    await symlink(targetDir, logicalLink);

    try {
      configureLocalRuntimeLogging({
        dir: logsDir,
        now: () => new Date(2026, 7, 31, 10, 0, 0, 0).getTime(),
        loggerOptions: { env: { NODE_ENV: "production" }, level: "info" },
      });
      await expect(
        readCanonicalAgentConfig({
          agentDir: join(logicalLink, "researcher"),
          routeName: "researcher",
          trustedRoot: dataDir,
        }),
      ).resolves.toMatchObject({ name: "researcher" });
      await flushLocalRuntimeLogging();

      const logFiles = (await readdir(logsDir)).filter((file) =>
        /^runtime-.*\.log$/u.test(file),
      );
      expect(logFiles).toEqual(["runtime-2026083110.log"]);
      const contents = await readFile(join(logsDir, logFiles[0]!), "utf8");
      const persistedLine = contents
        .split("\n")
        .find((line) =>
          line.includes('"event":"agent_directory_link_followed"'),
        );
      expect(persistedLine).toBeDefined();
      const fieldsIndex = persistedLine!.indexOf("{");
      expect(fieldsIndex).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(persistedLine!.slice(fieldsIndex))).toMatchObject({
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "agents",
        logical_link_path: logicalLink,
        readlink_raw_target: targetDir,
        realpath_resolved_target: await realpath(targetDir),
        resolved_target_kind: "directory",
        target_scope: "data_dir_outside",
        root_kind: "other",
      });
    } finally {
      await shutdownLocalRuntimeLogging();
    }
  });

  it("reports dangling and non-directory links without a link-prohibition error", async () => {
    process.env[DATA_DIR_SOURCE_ENV] = "mavis_env";
    const dataDir = await mkdtemp(
      join(tmpdir(), "canonical-agent-diagnostic-unresolved-"),
    );
    const nonDirectoryRoot = await mkdtemp(
      join(tmpdir(), "canonical-agent-diagnostic-file-"),
    );
    cleanup.push(
      () => rm(nonDirectoryRoot, { recursive: true, force: true }),
      () => rm(dataDir, { recursive: true, force: true }),
    );
    const warnSpy = vi.spyOn(logger, "warn");

    await mkdir(join(dataDir, "agents"), { recursive: true });
    const missingTarget = join(dataDir, "missing-target");
    const danglingLink = join(dataDir, "agents", "researcher");
    await symlink(missingTarget, danglingLink);
    const unresolvedFailure = await readAgentDirectoryFailure({
      agentDir: danglingLink,
      routeName: "researcher",
      trustedRoot: dataDir,
    });
    expect(unresolvedFailure.message).toContain(
      "Agent directory does not exist or cannot be read.",
    );
    expect(unresolvedFailure.message).not.toContain(
      "must not contain symbolic links",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      {
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "agent",
        logical_link_path: danglingLink,
        readlink_raw_target: missingTarget,
        realpath_resolved_target: null,
        resolved_target_kind: "unresolvable",
        target_scope: "unresolvable",
        root_kind: "other",
      },
      "Following linked Agent directory",
    );

    const fileTarget = join(nonDirectoryRoot, "not-a-directory");
    const nonDirectoryLink = join(nonDirectoryRoot, "agents");
    await writeFile(fileTarget, "not a directory");
    await symlink(fileTarget, nonDirectoryLink);
    const nonDirectoryFailure = await readAgentDirectoryFailure({
      agentDir: join(nonDirectoryLink, "researcher"),
      routeName: "researcher",
      trustedRoot: nonDirectoryRoot,
    });
    expect(nonDirectoryFailure.message).toContain(
      "Agent directory is not a directory.",
    );
    expect(nonDirectoryFailure.message).not.toContain(
      "must not contain symbolic links",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      {
        event: "agent_directory_link_followed",
        data_dir_source: "mavis_env",
        segment: "agents",
        logical_link_path: nonDirectoryLink,
        readlink_raw_target: fileTarget,
        realpath_resolved_target: await realpath(fileTarget),
        resolved_target_kind: "not_directory",
        target_scope: "data_dir_inside",
        root_kind: "other",
      },
      "Following linked Agent directory",
    );
  });
});

describe("canonical Custom Agent legacy description fallback", () => {
  it.each([
    ["a malformed document without a top-level description", "broken: ["],
    [
      "an empty description with unrelated malformed YAML",
      "description:\nbroken: [",
    ],
    [
      "a plain description without a legacy colon and malformed YAML",
      "description: Plain text\nbroken: [",
    ],
    [
      "a YAML indicator prefix",
      "description: ? PSD localizer: preserve layers",
    ],
    [
      "an unclosed quote prefix",
      'description: "PSD localizer: preserve layers',
    ],
    [
      "an inline YAML comment",
      "description: PSD localizer: preserve layers # keep",
    ],
    [
      "an indented continuation",
      "description: PSD localizer: preserve layers\n  continuation: no",
    ],
    ["a trailing space", "description: PSD localizer: preserve layers "],
  ])(
    "keeps the legacy description fallback closed for %s",
    (_caseName, descriptionLine) => {
      let thrown: unknown;
      try {
        parseCanonicalAgentMarkdown(
          `---\nname: psd-localizer\n${descriptionLine}\n---\n`,
          "psd-localizer",
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "AGENT_CONFIG_INVALID",
        field: "frontmatter",
      });
    },
  );
});

async function readAgentDirectoryFailure(input: {
  readonly agentDir: string;
  readonly routeName: string;
  readonly trustedRoot: string;
}): Promise<AgentConfigError> {
  try {
    await readCanonicalAgentConfig(input);
  } catch (error) {
    if (error instanceof AgentConfigError) return error;
    throw error;
  }
  throw new Error("expected Agent directory validation to fail");
}

async function createAgentDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "canonical-agent-config-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const agentDir = join(dataDir, "agents", "researcher");
  await mkdir(agentDir, { recursive: true });
  return agentDir;
}
