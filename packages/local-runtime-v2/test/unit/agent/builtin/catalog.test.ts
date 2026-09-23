import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { resolveAgentCapabilities } from "@mavis/config";
import type {
  PromptReadSnapshot,
  PromptSnapshotSource,
} from "@mavis/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BuiltinAgentCatalog,
  canonicalBuiltinName,
  legacyNamesFor,
  resolveCanonicalCapabilities,
} from "../../../../src/service/agent/builtin/catalog.js";
import type {
  PromptFileReader,
  PromptReadContext,
} from "../../../../src/service/prompt-config/index.js";

const fixtureDirectories: string[] = [];
const markdownLinkPolicy =
  "- Do not wrap Markdown links in backticks, or put backticks inside the label or target.\n";

function extractCitationSection(prompt: string): string {
  const start = prompt.indexOf("## Citations");
  if (start < 0) return "";

  const endMarker =
    "Do not cite unused calls or unsupported claims, invent metadata, output bare parenthesized links, or add trailing source/reference lists.";
  const end = prompt.indexOf(endMarker, start);
  if (end < 0) return "";

  return prompt.slice(start, end + endMarker.length).trim();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function promptReadContext(directory: string): PromptReadContext {
  return {
    scopeId: "scope",
    subject: "anonymous",
    version: directory,
    cacheId: directory,
    directory,
    storageMode: "plaintext",
    keyVersion: "desktop-v1",
  };
}

function promptFiles(version: string): Readonly<Record<string, string>> {
  return {
    "worker/PERSONA.md": `${version} persona`,
    "worker/system-prompt.md.hbs": `${version} system`,
    "_default/prompt-base-all.md.hbs": `${version} base`,
    "_default/prompt-base-windows.md.hbs": "",
    "_default/prompt-base-worker.md.hbs": `${version} worker base`,
    "_default/prompt-session-root.md.hbs": `${version} root surface`,
  };
}

function promptReader(
  byDirectory: Readonly<Record<string, Readonly<Record<string, string>>>>,
): PromptFileReader & { readonly read: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn(
      async (context: PromptReadContext, relativePath: string) =>
        byDirectory[context.directory]?.[relativePath],
    ),
  };
}

describe("BuiltinAgentCatalog", () => {
  it("keeps managed Prompt keys POSIX-normalized on Windows", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-windows-prompt-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "worker"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["worker"]');
    await writeFile(join(root, "worker", "PERSONA.md"), "Static identity only");
    const snapshot = {} as PromptReadSnapshot;
    const source: PromptSnapshotSource = {
      capture: vi.fn(async () => snapshot),
      captureBuiltin: vi.fn(async () => snapshot),
      read: vi.fn(async (_snapshot, key) => ({
        kind: "found" as const,
        content: key,
      })),
    };
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await new BuiltinAgentCatalog({ assetsDir: root }).render({
      agentName: "worker",
      surface: "interactive",
      appMode: "coding",
      locale: "en-US",
      promptChannel: "online",
      capabilities: resolveAgentCapabilities({ tools: ["bash"] }),
      promptReadContext: { source, snapshot },
    });

    const keys = vi.mocked(source.read).mock.calls.map(([, key]) => key);
    expect(keys).toContain("_default/prompt-base-windows.md.hbs");
    expect(keys).toContain("worker/features/delegation.md.hbs");
    expect(keys.every((key) => !key.includes("\\"))).toBe(true);
  });

  it("continues locale fallback on a missing optional candidate and rejects an invalid managed template", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-locale-fallback-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "worker"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["worker"]');
    await writeFile(join(root, "worker", "PERSONA.md"), "static metadata");
    const snapshot = {} as PromptReadSnapshot;
    const source: PromptSnapshotSource = {
      capture: vi.fn(async () => snapshot),
      captureBuiltin: vi.fn(async () => snapshot),
      read: vi.fn(async (_snapshot, key) => {
        if (key === "worker/PERSONA-en.md") return { kind: "missing" as const };
        if (key === "worker/PERSONA.md")
          return { kind: "found" as const, content: "remote persona" };
        if (key === "worker/system-prompt.md.hbs")
          return { kind: "invalid" as const };
        return { kind: "missing" as const };
      }),
    };
    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    const input = {
      agentName: "worker",
      surface: "interactive" as const,
      appMode: "coding" as const,
      locale: "en-US",
      promptChannel: "online" as const,
      capabilities: resolveAgentCapabilities(),
      promptReadContext: { source, snapshot },
    };

    await expect(catalog.readCanonicalContent(input)).rejects.toThrow(
      "worker/system-prompt.md.hbs",
    );
    expect(source.read).toHaveBeenCalledWith(snapshot, "worker/PERSONA-en.md");
    expect(source.read).toHaveBeenCalledWith(snapshot, "worker/PERSONA.md");
  });

  it("reads every built-in template from the immutable context supplied for one render", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-prompt-context-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "worker"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["worker"]');
    await writeFile(join(root, "worker", "PERSONA.md"), "Static identity only");

    const v1 = promptReadContext("version-1");
    const v2 = promptReadContext("version-2");
    const reader = promptReader({
      "version-1": promptFiles("v1"),
      "version-2": promptFiles("v2"),
    });
    const catalog = new BuiltinAgentCatalog({
      assetsDir: root,
      promptFileReader: reader,
    });
    const input = {
      agentName: "worker",
      surface: "interactive" as const,
      appMode: "coding" as const,
      locale: "en-US",
      promptChannel: "online" as const,
      capabilities: resolveAgentCapabilities(),
    };

    const first = await catalog.render({ ...input, promptReadContext: v1 });
    const second = await catalog.render({ ...input, promptReadContext: v2 });

    expect(first).toMatchObject({
      persona: "v1 persona",
      corePrompt: "v1 system\n\nv1 base\n\nv1 worker base",
      surfacePrompt: "v1 root surface",
    });
    expect(second).toMatchObject({
      persona: "v2 persona",
      corePrompt: "v2 system\n\nv2 base\n\nv2 worker base",
      surfacePrompt: "v2 root surface",
    });
    expect(
      reader.read.mock.calls.filter(([context]) => context === v1),
    ).not.toHaveLength(0);
    expect(
      reader.read.mock.calls.filter(([context]) => context === v2),
    ).not.toHaveLength(0);
    expect(
      reader.read.mock.calls
        .filter(([context]) => context === v1)
        .every(([context]) => context === v1),
    ).toBe(true);
  });
});

describe("BuiltinAgentCatalog recoverable deletion guidance", () => {
  it("teaches Mavis to use the runtime-owned recoverable deletion path", async () => {
    const assetsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../assets/agents",
    );
    const catalog = new BuiltinAgentCatalog({ assetsDir });
    const common = {
      agentName: "mavis",
      surface: "interactive" as const,
      locale: "en-US",
      promptChannel: "online" as const,
    };

    for (const appMode of ["coding", "work"] as const) {
      const rendered = await catalog.render({
        ...common,
        appMode,
        capabilities: resolveAgentCapabilities({ tools: ["bash"] }),
      });

      expect(rendered.corePrompt).toContain("## Recoverable Deletion");
      expect(rendered.corePrompt).toContain("activeDataDir");
      expect(rendered.corePrompt).toContain("/bin/mavis-trash");
      expect(rendered.corePrompt).toMatch(
        /never guess it or use\s+bare `mavis-trash`/u,
      );
      expect(rendered.corePrompt).toMatch(
        /never fall back to permanent\s+deletion/u,
      );
    }

    const withoutBash = await catalog.render({
      ...common,
      appMode: "coding",
      capabilities: resolveAgentCapabilities({ tools: [] }),
    });
    expect(withoutBash.corePrompt).not.toContain("## Recoverable Deletion");
  });
});

describe("BuiltinAgentCatalog Explore composition", () => {
  it("keeps Explore Bash boundaries in V1 and V2 assets and task reuse in V1 delegation", async () => {
    const assetsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../assets/agents",
    );
    const [v1ExplorePrompt, v2ExplorePrompt, delegation] = await Promise.all([
      readFile(join(assetsDir, "explore", "system-prompt.md.hbs"), "utf8"),
      readFile(join(assetsDir, "_v2", "explore.md.hbs"), "utf8"),
      readFile(
        join(assetsDir, "mavis", "features", "delegation.md.hbs"),
        "utf8",
      ),
    ]);

    for (const explorePrompt of [v1ExplorePrompt, v2ExplorePrompt]) {
      expect(explorePrompt).toContain("Read-only Bash");
      expect(explorePrompt).toContain(
        "Use `bash` only to inspect existing code or Git state.",
      );
      expect(explorePrompt).toContain(
        "Do not modify files, Git\nstate, or external systems",
      );
      expect(explorePrompt).toContain(
        "Explore does not have `task_output`, so do not use `run_in_background` with\n`bash`.",
      );
    }
    expect(delegation).toContain(
      "`bash` for read-only Git and code investigation.",
    );
    expect(delegation).toContain(
      "reuse the existing task with `task_append` instead of opening a\nnew task.",
    );
  });
});

describe("BuiltinAgentCatalog composition", () => {
  it("keeps local evidence rules and citations without a web-search system section", async () => {
    const assetsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../assets/agents",
    );
    const catalog = new BuiltinAgentCatalog({ assetsDir });

    const rendered = await catalog.render({
      agentName: "mavis",
      surface: "interactive",
      promptMode: "work",
      appMode: "work",
      locale: "zh-CN",
      promptChannel: "online",
      capabilities: resolveAgentCapabilities({ features: { webSearch: true } }),
    });

    const citationSection = extractCitationSection(rendered.corePrompt);
    expect(rendered.corePrompt).not.toContain("Factual Freshness And Search");
    expect(rendered.corePrompt).not.toContain(
      "Prefer primary or authoritative sources",
    );
    expect(rendered.corePrompt).toContain(
      "For unfamiliar project-specific concepts, search the workspace with `grep` or `glob` first.",
    );
    expect(rendered.corePrompt).toContain(
      "unfamiliarity alone does not prove non-existence",
    );
    expect(citationSection).toContain("Web: use the exact result/final URL.");
    expect(citationSection).toContain(
      "Do not cite unused calls or unsupported claims",
    );
    expect(citationSection).toContain(
      "Place citations at sentence granularity; do not group multiple citations at the end of a paragraph.",
    );
    expect(citationSection).toContain(
      "For tables, use a source column per row or a source line below the table.",
    );
    expect(rendered.corePrompt).not.toContain("contextual Markdown link");
    expect(rendered.corePrompt).not.toContain("Do not emit favicon");
    expect(rendered.corePrompt).not.toContain("## Tool source citations");
  });
  it("avoids duplicating the shared Mavis mode layer while retaining Windows and worker bases", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-shared-base-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "mavis", "modes", "coding", "online"), {
      recursive: true,
    });
    await mkdir(join(root, "worker"), { recursive: true });
    await mkdir(join(root, "_default"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["mavis", "worker"]');
    await writeFile(
      join(root, "mavis", "modes", "coding", "online", "SYSTEM.md.hbs"),
      "## Harness\nMavis system",
    );
    await writeFile(
      join(root, "mavis", "modes", "coding", "online", "PERSONA.md"),
      "Mavis persona",
    );
    await writeFile(join(root, "worker", "PERSONA.md"), "Worker persona");
    await writeFile(join(root, "worker", "system-prompt.md"), "Worker system");
    await writeFile(
      join(root, "_default", "prompt-base-all.md"),
      "## Harness\nshared base",
    );
    await writeFile(
      join(root, "_default", "prompt-base-windows.md"),
      "windows base",
    );
    await writeFile(
      join(root, "_default", "prompt-base-worker.md"),
      "worker base",
    );
    await writeFile(
      join(root, "_default", "prompt-session-root.md"),
      "root session",
    );

    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const common = {
      surface: "interactive" as const,
      appMode: "coding" as const,
      locale: "en-US",
      promptChannel: "online" as const,
      capabilities: resolveAgentCapabilities({
        tools: ["bash"],
        features: { mavis: false, delegation: false, webSearch: false },
      }),
    };

    const mavis = await catalog.render({ ...common, agentName: "mavis" });
    expect(mavis.corePrompt).toBe("## Harness\nMavis system\n\nwindows base");
    expect(mavis.corePrompt.match(/^## Harness$/gmu)).toHaveLength(1);
    await expect(
      catalog.render({ ...common, agentName: "worker" }),
    ).resolves.toMatchObject({
      corePrompt:
        "Worker system\n\n## Harness\nshared base\n\nwindows base\n\nworker base",
    });
  });

  it("honors an empty Windows template without reviving fallback content", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-windows-base-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "worker"), { recursive: true });
    await mkdir(join(root, "_default"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["worker"]');
    await writeFile(join(root, "worker", "PERSONA.md"), "Worker persona");
    await writeFile(join(root, "worker", "system-prompt.md"), "Worker system");
    await writeFile(
      join(root, "_default", "prompt-base-all.md"),
      "shared base",
    );
    await writeFile(
      join(root, "_default", "prompt-base-worker.md"),
      "worker base",
    );
    await writeFile(
      join(root, "_default", "prompt-base-windows.md"),
      "windows base",
    );
    await writeFile(join(root, "_default", "prompt-base-windows.md.hbs"), "");

    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    const common = {
      agentName: "worker",
      surface: "interactive" as const,
      appMode: "coding" as const,
      locale: "en-US",
      promptChannel: "online" as const,
    };

    await expect(
      catalog.render({
        ...common,
        capabilities: resolveAgentCapabilities({ tools: ["bash"] }),
      }),
    ).resolves.toMatchObject({
      corePrompt: "Worker system\n\nshared base\n\nworker base",
    });
    await expect(
      catalog.render({
        ...common,
        capabilities: resolveAgentCapabilities({ tools: [] }),
      }),
    ).resolves.toMatchObject({
      corePrompt: "Worker system\n\nshared base\n\nworker base",
    });
  });
});

describe("BuiltinAgentCatalog localized assets", () => {
  it("uses English built-in personas while keeping greeting assets localized", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-assets-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "explore", "features"), { recursive: true });
    await mkdir(join(root, "_default"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["explore"]');
    await writeFile(
      join(root, "explore", "PERSONA.md"),
      "---\ndisplay_name: Explore\ndescription: Explore agent\navatar: explore.png\n---\nExplore EN",
    );
    await writeFile(
      join(root, "explore", "PERSONA-zh.md"),
      "---\ndisplay_name: 探索\n---\n探索",
    );
    await writeFile(
      join(root, "explore", "system-prompt.md.hbs"),
      "System {{features.mavis}}",
    );
    await writeFile(
      join(root, "explore", "agent.md"),
      "---\nfeatures:\n  mavis: true\n  delegation: true\n  webSearch: false\n---\n",
    );
    await writeFile(
      join(root, "explore", "features", "delegation.md.hbs"),
      "Delegation {{features.delegation}}",
    );
    await writeFile(
      join(root, "_default", "prompt-session-root.md.hbs"),
      "Root {{surface.interactive}}",
    );
    await writeFile(
      join(root, "_default", "prompt-session-branch.md.hbs"),
      "Branch {{surface.taskChild}}",
    );
    await writeFile(
      join(root, "_default", "prompt-base-all.md"),
      "shared base",
    );
    await writeFile(
      join(root, "_default", "prompt-base-worker.md"),
      "worker base",
    );
    // Include the required platform layer without changing this fixture's expected prose.
    await writeFile(join(root, "_default", "prompt-base-windows.md.hbs"), "");
    await writeFile(join(root, "greeting-zh.md"), "你好");
    await writeFile(join(root, "greeting.md"), "Hello");

    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    await expect(catalog.resolveAssetsDir()).resolves.toBe(root);
    expect(canonicalBuiltinName(" MAIN ")).toBe("mavis");
    expect(legacyNamesFor("explore")).toEqual([]);
    await expect(catalog.hasBuiltin("EXPLORE")).resolves.toBe(true);
    // A detached historic built-in is no longer an alias of a canonical role.
    await expect(catalog.hasBuiltin("general")).resolves.toBe(false);
    await expect(catalog.hasBuiltin("missing")).resolves.toBe(false);
    await expect(catalog.listDefinitions()).resolves.toEqual([
      expect.objectContaining({
        name: "explore",
        legacyNames: [],
        identity: {
          displayName: "Explore",
          description: "Explore agent",
          avatar: "explore.png",
        },
        capabilityOverride: expect.objectContaining({
          features: expect.any(Object),
        }),
      }),
    ]);
    await expect(catalog.readDefinition("missing")).rejects.toThrow(
      /not in the roster/u,
    );

    const rendered = await catalog.render({
      agentName: "EXPLORE",
      surface: "interactive",
      appMode: "coding",
      locale: "zh-CN",
      promptChannel: "online",
      capabilities: resolveAgentCapabilities(),
      memoryEnabled: false,
      dataDirToken: "/data/token",
    });
    expect(rendered).toMatchObject({
      persona: "Explore EN",
      corePrompt: "System true\n\nshared base\n\nworker base",
      surfacePrompt: "Root true",
      assetAgentName: "explore",
      identity: { displayName: "Explore" },
    });
    await expect(
      catalog.readCanonicalContent({
        agentName: "EXPLORE",
        surface: "interactive",
        appMode: "coding",
        locale: "zh-CN",
        promptChannel: "online",
        capabilities: resolveAgentCapabilities(),
        memoryEnabled: false,
        dataDirToken: "/data/token",
      }),
    ).resolves.toMatchObject({
      persona: "Explore EN",
      systemPrompt: "System true",
    });
    await expect(
      catalog.render({
        agentName: "explore",
        surface: "task-child",
        appMode: "coding",
        locale: "en-US",
        promptChannel: "online",
        capabilities: resolveAgentCapabilities(),
      }),
    ).resolves.toMatchObject({ surfacePrompt: "Branch true" });
    await expect(catalog.readGreetingTemplate("zh-CN")).resolves.toBe("你好");
    await expect(catalog.readGreetingTemplate("en-US")).resolves.toBe("Hello");
  });
});

describe("BuiltinAgentCatalog validation and fallback rendering", () => {
  it("uses Handlebars strict rendering to reject unknown variables", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-template-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "explore"), { recursive: true });
    await mkdir(join(root, "_default"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["explore"]');
    await writeFile(
      join(root, "explore", "PERSONA.md"),
      "---\ndisplay_name: Explore\n---\nExplore",
    );
    await writeFile(
      join(root, "explore", "system-prompt.md.hbs"),
      "{{unknownVariable}}",
    );
    await writeFile(
      join(root, "_default", "prompt-session-root.md.hbs"),
      "{{surface.interactive}}",
    );

    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    await expect(
      catalog.render({
        agentName: "explore",
        surface: "interactive",
        appMode: "coding",
        locale: "en-US",
        promptChannel: "online",
        capabilities: resolveAgentCapabilities(),
      }),
    ).rejects.toThrow(/unknownVariable|not defined/u);
  });

  it("handles plain persona assets, missing optional templates, and fallback greetings", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-assets-minimal-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "explore"), { recursive: true });
    await mkdir(join(root, "_default"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["explore"]');
    await writeFile(
      join(root, "explore", "PERSONA.md"),
      "Plain persona without frontmatter",
    );
    await writeFile(
      join(root, "_default", "prompt-base-all.md"),
      "shared base",
    );
    await writeFile(
      join(root, "_default", "prompt-base-worker.md"),
      "worker base",
    );
    // Include the required platform layer without changing this fixture's expected prose.
    await writeFile(join(root, "_default", "prompt-base-windows.md.hbs"), "");
    await writeFile(
      join(root, "_default", "prompt-session-root.md.hbs"),
      "fallback root",
    );
    await writeFile(join(root, "greeting.md"), "generic greeting");

    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    await expect(catalog.readDefinition("explore")).resolves.toMatchObject({
      name: "explore",
      identity: {},
    });
    await expect(
      catalog.render({
        agentName: "explore",
        surface: "interactive",
        appMode: "coding",
        locale: "fr-FR",
        promptChannel: "online",
        capabilities: resolveAgentCapabilities(),
      }),
    ).resolves.toMatchObject({
      persona: "Plain persona without frontmatter",
      corePrompt: "shared base\n\nworker base",
      surfacePrompt: "fallback root",
    });
    await expect(catalog.readGreetingTemplate("zh-CN")).resolves.toBe(
      "generic greeting",
    );
    await expect(catalog.readGreetingTemplate("en-US")).resolves.toBe(
      "generic greeting",
    );
  });

  it("renders primary internal-channel fallback and resolves capability intersections", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-assets-primary-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "mavis", "modes", "coding", "online"), {
      recursive: true,
    });
    await mkdir(join(root, "_default"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["mavis"]');
    await writeFile(
      join(root, "mavis", "modes", "coding", "online", "SYSTEM.md.hbs"),
      "online",
    );
    await writeFile(
      join(root, "mavis", "modes", "coding", "online", "PERSONA.md"),
      "Mavis",
    );
    await writeFile(
      join(root, "mavis", "modes", "coding", "online", "PERSONA-zh.md"),
      "马维斯",
    );
    await writeFile(
      join(root, "_default", "prompt-base-all.md"),
      "shared base",
    );
    await writeFile(join(root, "_default", "prompt-session-root.md"), "root");
    const catalog = new BuiltinAgentCatalog({ assetsDir: root });

    await expect(
      catalog.render({
        agentName: "mavis",
        surface: "interactive",
        appMode: "coding",
        locale: "zh-CN",
        promptChannel: "internal",
        capabilities: resolveAgentCapabilities({
          tools: [],
          features: { mavis: false, delegation: false, webSearch: false },
        }),
      }),
    ).resolves.toMatchObject({ corePrompt: "online", persona: "Mavis" });

    const resolved = resolveCanonicalCapabilities(
      {
        persona: { enabled: true },
        tools: ["read", "write"] as never,
        features: { mavis: true, delegation: true, webSearch: true },
      },
      { persona: { enabled: false }, features: { delegation: false } },
    );
    expect(resolved).toMatchObject({
      persona: { enabled: false },
      tools: ["read", "write"],
      features: { mavis: true, delegation: false, webSearch: true },
    });
    expect(
      resolveCanonicalCapabilities(undefined, { tools: ["read"] as never })
        .tools,
    ).toEqual(["read"]);
    expect(
      resolveCanonicalCapabilities({ tools: ["read"] as never }, undefined)
        .tools,
    ).toEqual(["read"]);
    expect(canonicalBuiltinName("unknown")).toBe("unknown");
    expect(canonicalBuiltinName("general")).toBe("general");
    expect(legacyNamesFor("mavis")).toEqual(["main"]);
    expect(legacyNamesFor("unknown")).toEqual([]);
  });

  it("rejects malformed built-in rosters instead of silently accepting them", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-assets-roster-"),
    );
    fixtureDirectories.push(root);
    await writeFile(join(root, "builtin-agents.json"), '{"explore":true}');
    const catalog = new BuiltinAgentCatalog({ assetsDir: root });

    await expect(catalog.listDefinitions()).rejects.toThrow(
      "roster must be an array",
    );
  });
});

describe("BuiltinAgentCatalog TodoWrite lifecycle guidance", () => {
  it("leaves TodoWrite lifecycle guidance to the tool description", async () => {
    const catalog = new BuiltinAgentCatalog();
    const common = {
      surface: "interactive" as const,
      promptMode: "coding" as const,
      appMode: "coding" as const,
      locale: "en",
      promptChannel: "online" as const,
      memoryEnabled: false,
      cronEnabled: false,
    };
    const [mavis, work, worker, withoutTodoWrite] = await Promise.all([
      catalog.render({
        ...common,
        agentName: "mavis",
        capabilities: resolveAgentCapabilities(),
      }),
      catalog.render({
        ...common,
        agentName: "mavis",
        appMode: "work",
        promptMode: "work",
        capabilities: resolveAgentCapabilities(),
      }),
      catalog.render({
        ...common,
        agentName: "worker",
        capabilities: resolveAgentCapabilities(),
      }),
      catalog.render({
        ...common,
        agentName: "mavis",
        capabilities: resolveAgentCapabilities({ tools: ["read"] }),
      }),
    ]);

    for (const rendered of [mavis, work, worker, withoutTodoWrite]) {
      expect(rendered.corePrompt).not.toContain("Task Management");
      expect(rendered.corePrompt).not.toContain(
        "When tracking work with TodoWrite",
      );
      expect(rendered.corePrompt).not.toContain("`in_progress`");
    }
  });
});

describe("BuiltinAgentCatalog session surfaces", () => {
  it("ships the response style contract in coding and work online prompts", async () => {
    const catalog = new BuiltinAgentCatalog();
    const common = {
      agentName: "mavis",
      surface: "interactive" as const,
      locale: "en-US",
      promptChannel: "online" as const,
      capabilities: resolveAgentCapabilities(),
    };

    const [coding, work] = await Promise.all([
      catalog.render({ ...common, appMode: "coding", promptMode: "coding" }),
      catalog.render({ ...common, appMode: "work", promptMode: "work" }),
    ]);

    for (const rendered of [coding, work]) {
      expect(rendered.corePrompt).toContain("## Response Style");
      expect(rendered.corePrompt).not.toContain("use 1 to 3 short paragraphs");
      expect(rendered.corePrompt).toContain(
        "For a one-point explanation, use compact prose without a heading, bullet recap, or code excerpt unless the user asks for one",
      );
      expect(rendered.corePrompt).toContain(
        "Indent supporting paragraphs or nested lists inside that numbered item",
      );
      expect(rendered.corePrompt).toContain(
        "File: source every code-file mention",
      );
      expect(rendered.corePrompt).not.toContain("<filepath>");
      expect(rendered.corePrompt).toContain(markdownLinkPolicy);
    }
  });

  it("uses the complete coding template for CLI while preserving capability gates", async () => {
    const catalog = new BuiltinAgentCatalog();
    const capabilities = resolveAgentCapabilities({
      features: { mavis: true, delegation: true, webSearch: true },
    });
    const common = {
      agentName: "mavis",
      appMode: "coding" as const,
      promptMode: "coding" as const,
      promptChannel: "online" as const,
      capabilities,
      memoryEnabled: false,
      cronEnabled: false,
    };

    const [coding, codingZh, cli, cliZh, cliWithoutDelegation] =
      await Promise.all([
        catalog.render({ ...common, surface: "interactive", locale: "en" }),
        catalog.render({ ...common, surface: "interactive", locale: "zh" }),
        catalog.render({ ...common, surface: "cli", locale: "en" }),
        catalog.render({ ...common, surface: "cli", locale: "zh" }),
        catalog.render({
          ...common,
          surface: "cli",
          locale: "en",
          capabilities: resolveAgentCapabilities({
            features: { mavis: true, delegation: false, webSearch: true },
          }),
        }),
      ]);

    expect(cli.persona).toBe(coding.persona);
    expect(cliZh.corePrompt).toBe(cli.corePrompt);
    expect(codingZh.persona).toBe(coding.persona);
    expect(codingZh.corePrompt).toBe(coding.corePrompt);
    expect(cli.corePrompt).toContain(
      "user's active MiniMax Code terminal conversation",
    );
    expect(coding.corePrompt).toContain("this agent's root session");
    expect(cli.corePrompt).toContain("# Core Judgment");
    expect(cli.persona).toBeUndefined();
    expect(cliZh.corePrompt).toContain(
      "You help users with software engineering tasks.",
    );
    expect(cliZh.corePrompt).not.toContain("You are Mavis");
    expect(cliZh.corePrompt).not.toContain("MiniMax As a Jarvis");
    expect(cli.corePrompt).not.toContain("# Work Rules");
    expect(cli.corePrompt).toContain("# Communication & Delivery");
    expect(cliWithoutDelegation.corePrompt).not.toContain("Task Routing");
    expect(cli.corePrompt).not.toContain("Task Routing");
    expect(cli.corePrompt).not.toContain("## Self-Reminder via Cron");
    expect(cli.corePrompt).not.toContain("# Memory");
  });

  it.each(["coding", "work"] as const)(
    "keeps task and Cron guidance outside the %s system prompt",
    async (appMode) => {
      const catalog = new BuiltinAgentCatalog();
      const rendered = await catalog.render({
        agentName: "mavis",
        surface: "interactive",
        appMode,
        promptMode: appMode,
        locale: "en",
        promptChannel: "online",
        capabilities: resolveAgentCapabilities({
          features: { mavis: true, delegation: true, webSearch: true },
        }),
        memoryEnabled: false,
        cronEnabled: true,
      });

      const corePrompt = rendered.corePrompt.replace(/\s+/gu, " ");
      expect(corePrompt).not.toContain("Scheduled Work and Async Follow-up");
      expect(corePrompt).not.toContain(
        "Use Cron only to schedule a future Agent turn",
      );
      expect(corePrompt).not.toContain("Use `cron once` for one future turn");
      expect(corePrompt).not.toContain("Use `cron self`");
      expect(corePrompt).not.toContain("Task Routing");
      expect(corePrompt).not.toContain(
        "The child does not inherit this conversation",
      );
      expect(corePrompt).not.toContain("## Task Management");
    },
  );

  it("renders the shared session surface for custom Agents and appends the child contract", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-surface-"),
    );
    const customDir = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-custom-"),
    );
    fixtureDirectories.push(root, customDir);
    await mkdir(join(root, "_default"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), "[]");
    await writeFile(
      join(root, "_default", "prompt-session-root.md.hbs"),
      "Default root",
    );
    await writeFile(
      join(root, "_default", "prompt-session-branch.md.hbs"),
      "{{#if surface.taskChild}}Default child contract{{/if}}",
    );
    await writeFile(
      join(customDir, "prompt-session-root.md"),
      "Custom root override",
    );
    await writeFile(
      join(customDir, "prompt-session-branch.md"),
      "Custom child override",
    );

    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    const common = {
      agentName: "custom",
      appMode: "coding" as const,
      locale: "en-US",
      promptChannel: "online" as const,
      capabilities: resolveAgentCapabilities(),
    };
    await expect(
      catalog.renderSurfacePrompt({
        ...common,
        surface: "interactive",
        agentConfigDir: customDir,
      }),
    ).resolves.toBe("Custom root override");
    await expect(
      catalog.renderSurfacePrompt({
        ...common,
        surface: "task-child",
        agentConfigDir: customDir,
      }),
    ).resolves.toBe("Custom child override\n\nDefault child contract");
  });

  it("keeps legacy role names out of model-visible Mavis onboarding assets", async () => {
    const catalog = new BuiltinAgentCatalog();
    const root = await catalog.resolveAssetsDir();
    expect(root).toBe(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../assets/agents",
      ),
    );
    const systemPrompt = await readFile(
      join(root, "mavis", "system-prompt.md.hbs"),
      "utf8",
    );
    expect(systemPrompt).not.toMatch(
      /legacy\s+(?:general|coder)|(?:general|coder)\s*\/\s*(?:coder|general)|explicitly approves|go-ahead/,
    );
  });

  it("keeps product knowledge in the Mavis Skill catalog instead of duplicating it in mode prompts", async () => {
    const catalog = new BuiltinAgentCatalog();
    const root = await catalog.resolveAssetsDir();
    const common = {
      agentName: "mavis",
      surface: "interactive" as const,
      locale: "en-US",
      promptChannel: "online" as const,
      capabilities: resolveAgentCapabilities(),
    };
    const [coding, work, productSkill] = await Promise.all([
      catalog.render({ ...common, appMode: "coding", promptMode: "coding" }),
      catalog.render({ ...common, appMode: "work", promptMode: "work" }),
      readFile(
        join(root, "mavis", "skills", "minimax-code-product", "SKILL.md"),
        "utf8",
      ),
    ]);

    for (const rendered of [coding, work]) {
      expect(rendered.corePrompt).not.toContain("minimax-code-product");
      expect(rendered.corePrompt).not.toContain(
        "Do not guess dynamic product facts from model memory.",
      );
    }
    expect(productSkill).toMatch(/官方|authoritative/i);
    expect(productSkill).toMatch(
      /核实顺序|verification workflow|official source discovery/i,
    );
    expect(productSkill).toContain("https://agent.minimax.cn/docs/llms.txt");
    expect(productSkill).toContain(
      "https://platform.minimaxi.com/docs/llms.txt",
    );
    expect(productSkill).toContain("https://agent.minimax.io/docs/llms.txt");
    expect(productSkill).toContain("https://platform.minimax.io/docs/llms.txt");
    expect(productSkill).toContain(
      "https://agent.minimax.cn/docs/changelog.md",
    );
    expect(productSkill).toContain(
      "https://agent.minimax.io/docs/changelog.md",
    );
    expect(productSkill).toMatch(
      /current-region Desktop changelog[\s\S]*latest-version/i,
    );
    expect(productSkill).toMatch(/version\/date[\s\S]*download links/i);
    expect(productSkill).not.toMatch(/latest\.yml|latest-mac\.yml/i);
    expect(productSkill).not.toMatch(
      /filecdn\.minimax\.chat|file\.cdn\.minimax\.io/i,
    );
    expect(productSkill).not.toMatch(
      /https:\/\/agent\.minimaxi\.com|process\.platform/,
    );
    expect(productSkill).not.toContain("web_fetch");
    expect(productSkill).not.toMatch(
      /国内 Changelog[^\n]*https:\/\/agent\.minimax\.cn\/docs\/changelog(?!\.md)/i,
    );
    expect(productSkill).not.toMatch(
      /海外 Changelog[^\n]*https:\/\/agent\.minimax\.io\/docs\/changelog(?!\.md)/i,
    );
    expect(productSkill).not.toMatch(/\b(?:test|staging|inside)\b/i);
    expect(productSkill).not.toMatch(/最新版本\s*[:：]\s*v?\d/i);
    expect(productSkill).not.toMatch(
      /https?:\/\/[^\s)]+\.(?:dmg|exe|zip|pkg)/i,
    );
  });
});

describe("BuiltinAgentCatalog Desktop V2 prompt profile", () => {
  it.each(["coding", "work"] as const)(
    "reads %s and child context from one remote version",
    async (appMode) => {
      const files = (version: string) => ({
        [`_v2/${appMode}/SYSTEM.md.hbs`]: `${version} ${appMode} {{#if memory.enabled}}memory{{/if}}`,
        "_v2/worker.md.hbs": `${version} worker`,
        "_v2/AGENT_CONTEXT.md.hbs": `${version} shared context`,
      });
      const reader = promptReader({ a: files("a"), b: files("b") });
      const catalog = new BuiltinAgentCatalog({ promptFileReader: reader });
      const input = {
        agentName: "mavis",
        surface: "interactive" as const,
        promptProfile: "desktop" as const,
        appMode,
        locale: "en",
        promptChannel: "online" as const,
        capabilities: resolveAgentCapabilities(),
        memoryEnabled: true,
      };
      const a = promptReadContext("a");
      const b = promptReadContext("b");
      const first = await catalog.render({ ...input, promptReadContext: a });
      expect(first.corePrompt).toBe(`a ${appMode} memory`);
      expect(first.promptSnapshot?.template).toBe(
        files("a")[`_v2/${appMode}/SYSTEM.md.hbs`],
      );
      expect(
        (await catalog.render({ ...input, promptReadContext: b })).corePrompt,
      ).toBe(`b ${appMode} memory`);
      expect(
        (await catalog.render({ ...input, promptReadContext: a })).corePrompt,
      ).toBe(first.corePrompt);
      const child = await catalog.render({
        ...input,
        agentName: "worker",
        surface: "task-child",
        promptReadContext: a,
      });
      expect(child.corePrompt).toContain("a worker");
      expect(child.corePrompt).toContain("a shared context");
      expect(child.surfacePrompt).toContain("a shared context");
      expect(
        reader.read.mock.calls.every(([, key]) => key.startsWith("_v2/")),
      ).toBe(true);
    },
  );
});

describe("BuiltinAgentCatalog TUI prompt profile", () => {
  it.each(["coding", "work"] as const)(
    "uses the complete TUI template independently of the %s mode and Desktop snapshot",
    async (appMode) => {
      const reader = promptReader({ desktop: {} });
      const catalog = new BuiltinAgentCatalog({ promptFileReader: reader });
      const input = {
        agentName: "mavis",
        surface: "cli" as const,
        promptProfile: "tui" as const,
        appMode,
        locale: "zh-CN",
        promptChannel: "internal" as const,
        capabilities: resolveAgentCapabilities(),
        memoryEnabled: false,
        cronEnabled: false,
        promptReadContext: promptReadContext("desktop"),
      };
      const enabled = await catalog.render(input);
      const child = await catalog.render({ ...input, surface: "task-child" });
      expect(enabled.corePrompt).toContain(
        "You are a coding agent running in the MiniMax Code terminal",
      );
      expect(enabled.corePrompt).toContain("markdown in a terminal");
      expect(enabled.corePrompt).toContain("## Deliverable Files");
      expect(enabled.corePrompt).not.toContain("## Media Output");
      expect(enabled.surfacePrompt).toBe("");
      expect(child.surfacePrompt).toContain("hidden TUI child Agent");
      expect(reader.read).not.toHaveBeenCalled();
    },
  );

  it("requires the selected complete template and child context without Desktop fallback", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-tui-required-"),
    );
    fixtureDirectories.push(root);
    await mkdir(join(root, "_v2", "tui"), { recursive: true });
    await mkdir(join(root, "_default"), { recursive: true });
    await writeFile(join(root, "builtin-agents.json"), '["mavis"]');
    await writeFile(
      join(root, "_default", "prompt-session-branch.md.hbs"),
      "Desktop child",
    );
    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    const input = {
      agentName: "mavis",
      surface: "cli" as const,
      promptProfile: "tui" as const,
      appMode: "coding" as const,
      locale: "en",
      promptChannel: "online" as const,
      capabilities: resolveAgentCapabilities(),
    };
    await expect(catalog.render(input)).rejects.toThrow(
      "_v2/tui/SYSTEM.md.hbs",
    );
    await writeFile(join(root, "_v2/tui/SYSTEM.md.hbs"), "Complete TUI prompt");
    await expect(catalog.render(input)).resolves.toMatchObject({
      corePrompt: "Complete TUI prompt",
    });
    await expect(
      catalog.render({ ...input, surface: "task-child" }),
    ).rejects.toThrow("Mandatory TUI surface");
  });

  it("preserves TUI worker context and custom child surface overrides on Windows", async () => {
    const customDir = await mkdtemp(
      join(tmpdir(), "local-runtime-v2-agent-tui-child-"),
    );
    fixtureDirectories.push(customDir);
    await writeFile(
      join(customDir, "prompt-session-branch.md"),
      "Custom child briefing",
    );
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const catalog = new BuiltinAgentCatalog();
    const input = {
      agentName: "worker",
      surface: "task-child" as const,
      promptProfile: "tui" as const,
      appMode: "coding" as const,
      locale: "en",
      promptChannel: "online" as const,
      capabilities: resolveAgentCapabilities({ tools: ["bash"] }),
    };
    const rendered = await catalog.render(input);
    expect(rendered.corePrompt).toContain("Markdown in the terminal");
    expect(rendered.corePrompt).toContain("Do the work first, report after.");
    const surface = await catalog.renderSurfacePrompt({
      ...input,
      agentConfigDir: customDir,
    });
    expect(surface).toContain("Custom child briefing");
    expect(surface).toContain("hidden TUI child Agent");
  });
});

describe("BuiltinAgentCatalog persona assets", () => {
  it("keeps identity and Core Judgment in the complete coding template", async () => {
    const catalog = new BuiltinAgentCatalog();
    const root = await catalog.resolveAssetsDir();
    const persona = await readFile(join(root, "mavis", "PERSONA.md"), "utf8");
    const { corePrompt } = await catalog.render({
      agentName: "mavis",
      surface: "interactive",
      appMode: "coding",
      promptMode: "coding",
      locale: "en",
      promptChannel: "online",
      capabilities: resolveAgentCapabilities(),
    });

    expect(corePrompt).toContain(
      "When the goal is clear, move forward directly without repeated confirmations.",
    );
    expect(corePrompt).toContain(
      "When faced with ambiguity, first complete everything that does not depend on the answer.",
    );
    expect(corePrompt).toContain(
      "Report results faithfully: say what succeeded, what failed, what was skipped, and what remains unverified.",
    );
    expect(persona).toContain("display_name: Mavis");
    expect(persona).toContain("MiniMax Code");
    expect(persona).not.toContain("You are Mavis");
    expect(persona).not.toContain("Core Judgment");
    expect(persona).not.toContain("customer service");
    expect(persona).not.toContain("Warm But Not Soft");
    expect(persona).not.toContain("## Communication Style");
    expect(persona).not.toContain("sense of humor");
    expect(persona).not.toContain("being robotic");
  });
});

describe("BuiltinAgentCatalog citation surfaces", () => {
  it.each([false, true])(
    "shares citation and module structure with memory enabled: %s",
    async (memoryEnabled) => {
      const catalog = new BuiltinAgentCatalog();
      const common = {
        agentName: "mavis",
        surface: "interactive" as const,
        locale: "zh-CN",
        promptChannel: "online" as const,
        capabilities: resolveAgentCapabilities(),
        memoryEnabled,
      };
      const [coding, work] = await Promise.all([
        catalog.render({ ...common, appMode: "coding", promptMode: "coding" }),
        catalog.render({ ...common, appMode: "work", promptMode: "work" }),
      ]);

      const workCitations = extractCitationSection(work.corePrompt);
      const codingCitations = extractCitationSection(coding.corePrompt);

      for (const prompt of [work.corePrompt, coding.corePrompt]) {
        const headings = [...prompt.matchAll(/^# (.+)$/gmu)].map(
          (match) => match[1],
        );
        expect(headings).toEqual([
          "Harness",
          "Core Judgment",
          ...(memoryEnabled ? ["Memory"] : []),
          "Communication & Delivery",
        ]);
        expect(prompt).not.toContain("Avoid Redundant Reads");
        expect(prompt).not.toContain("memory(target=");
        if (memoryEnabled)
          expect(prompt).toContain(
            "If memory writes are unavailable, leave durable memory unchanged.",
          );
        const harness = prompt.slice(
          prompt.indexOf("# Harness"),
          prompt.indexOf("# Core Judgment"),
        );
        expect(harness).not.toMatch(/^#{2,6} /gmu);
        expect(harness).toContain(
          "Independent tool calls can run in parallel in one response.",
        );
        expect(harness).toContain(
          "Run dependent calls or conflicting writes sequentially",
        );
        expect(harness).toContain(
          "Text you output outside of tool use is displayed to the user as GitHub-flavored Markdown.",
        );
        const media = prompt.slice(
          prompt.indexOf("## Media Output"),
          prompt.indexOf("## Citations"),
        );
        expect(prompt.indexOf("## Media Output")).toBeGreaterThan(
          prompt.indexOf("# Communication & Delivery"),
        );
        expect(media).toContain("<deliver-assets>");
        expect(media).toContain('<media type="file"');
        expect(media).toContain("absolute local path");
        expect(media).toContain("created or modified files must exist");
        expect(media).toContain(
          "file existed before this turn and is now absent",
        );
        expect(media).toContain(
          "If creation or verification failed, report the failure",
        );
        const artifact = prompt.indexOf("## Artifact Completion Contract");
        if (artifact >= 0)
          expect(artifact).toBeGreaterThan(
            prompt.indexOf("# Communication & Delivery"),
          );
        expect(prompt).not.toContain("MCP/App citation examples");
        expect(prompt).not.toContain("Output Conventions");
        const style = prompt.slice(
          prompt.indexOf("## Response Style"),
          prompt.indexOf("## Preamble messages"),
        );
        expect(style).not.toContain("GitHub-flavored Markdown");
        expect(style).toContain("Use emoji sparingly");
        expect(prompt).not.toContain("Task Routing");
      }

      expect(workCitations).toBe(codingCitations);
      expect(workCitations).toContain(
        "MCP/App: use the exact ToolResult `Citation candidate`",
      );
      expect(workCitations).toContain("File: source every code-file mention");
      expect(workCitations).toContain("git diff paths auto-resolve");
      expect(workCitations).toContain(
        "Never leave sourceable code paths as inline/plain text",
      );
      expect(workCitations).toContain(
        "Label code `filename(line N)` or `filename(lines N-M)`",
      );
      expect(workCitations).toContain(
        "always label it with the App/MCP name. Client adds its icon",
      );
      expect(workCitations).not.toContain("localized `Source: [App](URL)`");
      expect(workCitations).toContain("Keep standalone sources outside lists");
      expect(workCitations).toContain(
        "Place citations at sentence granularity; do not group multiple citations at the end of a paragraph.",
      );
      expect(workCitations).toContain(
        "For tables, use a source column per row or a source line below the table.",
      );
      expect(workCitations).toContain(
        "Do not cite unused calls or unsupported claims",
      );
      expect(workCitations).toContain("output bare parenthesized links");
      expect(workCitations).toContain("add trailing source/reference lists");
      expect(workCitations.length).toBeLessThan(900);

      for (const prompt of [work.corePrompt, coding.corePrompt]) {
        expect(prompt).not.toContain("file_path:line_number");
        expect(prompt).not.toContain("<filepath>");
        expect(prompt).not.toContain("### Web Citation Placement");
        expect(prompt).not.toContain(
          "one semantic citation link at that block's end is enough",
        );
        expect(prompt).not.toContain("## Tool source citations");
        expect(prompt).not.toContain("Before finishing");
        expect(prompt).not.toContain("Available fetched source");
        expect(prompt.match(/File:/gu)).toHaveLength(1);
      }
    },
  );
});

describe("shipped canonical SubAgent definitions", () => {
  it.each(["explore", "worker", "verifier"])(
    "declares WebSearch explicitly for shipped %s",
    async (name) => {
      const definition = await new BuiltinAgentCatalog().readDefinition(name);

      expect(definition.capabilityOverride?.features?.webSearch).toBe(true);
    },
  );
});

describe("BuiltinAgentCatalog prompt modes", () => {
  const common = {
    agentName: "mavis",
    surface: "cli" as const,
    promptProfile: "tui" as const,
    appMode: "coding" as const,
    locale: "en",
    promptChannel: "online" as const,
    memoryEnabled: false,
    cronEnabled: false,
  };

  it("selects one complete file per mode and evaluates inline Memory and Persona gates", async () => {
    const catalog = new BuiltinAgentCatalog();
    const rendered = [];
    for (const promptMode of ["tui", "coding", "work"] as const) {
      const enabled = await catalog.render({
        ...common,
        promptMode,
        memoryEnabled: true,
        capabilities: resolveAgentCapabilities(),
      });
      const disabled = await catalog.render({
        ...common,
        promptMode,
        capabilities: resolveAgentCapabilities({ persona: { enabled: false } }),
      });
      expect(enabled.promptSnapshot?.mode).toBe(promptMode);
      expect(enabled.promptSnapshot?.template).toContain(
        "{{#if memory.enabled}}",
      );
      expect(enabled.corePrompt).toContain("# Memory");
      expect(disabled.corePrompt).not.toContain("# Memory");
      expect(disabled.corePrompt).not.toContain(
        enabled.corePrompt.trim().split("\n")[0],
      );
      expect(enabled.corePrompt).not.toMatch(
        /## (Task Routing|Task Management|Factual Freshness)/,
      );
      const resumed = catalog.renderPromptSnapshot(
        { ...common, promptMode, capabilities: resolveAgentCapabilities() },
        enabled.promptSnapshot!,
      );
      expect(resumed.systemPrompt).not.toContain("# Memory");
      rendered.push(enabled);
    }
    expect(rendered[0]?.corePrompt).toContain(
      "You are a coding agent running in the MiniMax Code terminal",
    );
    expect(rendered[1]?.corePrompt).toContain(
      "You help users with software engineering tasks.",
    );
    expect(rendered[2]?.corePrompt).toContain(
      "You help users research, analyze information, and create professional deliverables.",
    );
    expect(rendered[0]?.corePrompt).toContain("## Deliverable Files");
    expect(rendered[1]?.corePrompt).toContain("## Media Output");
    expect(
      new Set(rendered.map((item) => item.promptSnapshot?.template)).size,
    ).toBe(3);
  });

  it("freezes every mode before first render, including initially disabled Memory and Workflow text", async () => {
    const root = await mkdtemp(join(tmpdir(), "prompt-mode-frozen-"));
    fixtureDirectories.push(root);
    await cp(await new BuiltinAgentCatalog().resolveAssetsDir(), root, {
      recursive: true,
    });
    const catalog = new BuiltinAgentCatalog({
      assetsDir: root,
      freezeLocalPrompts: true,
    });
    await catalog.render({
      ...common,
      promptMode: "tui",
      capabilities: resolveAgentCapabilities(),
    });
    const source = (await catalog.frozenPromptSource())!;
    const snapshot = await source.capture();
    const workflowKey = "workflow/plan-mode/agent-entry.md";
    const workflow = await source.read(snapshot, workflowKey);
    await writeFile(join(root, workflowKey), "changed workflow");
    expect(await source.read(await source.capture(), workflowKey)).toEqual(
      workflow,
    );
    await writeFile(
      join(root, "_v2/work/SYSTEM.md.hbs"),
      "Changed Work prompt",
    );
    const input = {
      ...common,
      promptMode: "work" as const,
      memoryEnabled: true,
      capabilities: resolveAgentCapabilities(),
    };
    const frozen = await catalog.render(input);
    expect(frozen.corePrompt).toContain("# Memory");
    expect(frozen.corePrompt).not.toContain("Changed Work prompt");
    const fresh = await new BuiltinAgentCatalog({ assetsDir: root }).render(
      input,
    );
    expect(fresh.corePrompt).toBe("Changed Work prompt");
  });

  it("reads V2 without V1 feature files and rejects a missing selected mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "prompt-mode-required-"));
    fixtureDirectories.push(root);
    await cp(await new BuiltinAgentCatalog().resolveAssetsDir(), root, {
      recursive: true,
    });
    const catalog = new BuiltinAgentCatalog({ assetsDir: root });
    await rm(join(root, "mavis/features"), { recursive: true });
    const input = {
      ...common,
      promptMode: "work" as const,
      capabilities: resolveAgentCapabilities(),
    };
    await expect(catalog.render(input)).resolves.toMatchObject({
      promptSnapshot: { mode: "work" },
    });
    await rm(join(root, "_v2/work/SYSTEM.md.hbs"));
    await expect(catalog.render(input)).rejects.toThrow(
      "_v2/work/SYSTEM.md.hbs",
    );
  });
});

describe('Bash prompt contract across product surfaces', () => {
  it.each([
    { agentName: 'worker', surface: 'task-child', promptProfile: undefined },
    { agentName: 'mavis', surface: 'interactive', promptProfile: 'desktop' },
    { agentName: 'mavis', surface: 'cli', promptProfile: 'tui' },
    { agentName: 'worker', surface: 'task-child', promptProfile: 'tui' },
  ] as const)(
    'renders capability-neutral base guidance for $agentName / $surface / $promptProfile',
    async (profile) => {
      const catalog = new BuiltinAgentCatalog();
      const rendered = await catalog.render({
        ...profile,
        appMode: 'coding',
        locale: 'zh-CN',
        promptChannel: 'online',
        capabilities: resolveAgentCapabilities({ tools: ['bash'] }),
      });
      const text = [rendered.corePrompt, rendered.surfacePrompt].join('\n');
      expect(text).not.toContain('and yield to the same managed background process after 15s');
      expect(text).not.toContain('PowerShell syntax only');
    },
  );
});
