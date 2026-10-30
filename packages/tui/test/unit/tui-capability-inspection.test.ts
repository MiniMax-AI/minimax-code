import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import {
  createTuiMcpInspectionPanel,
  createTuiSkillsInspectionPanel,
} from "../../src/tui/features/inspection/capabilities.js";
import { createTuiContextInspection } from "../../src/tui/features/inspection/product-inspection.js";
import { ContextVisualization } from "../../src/tui/transcript/context-visualization.js";

describe("MCode capability inspection", () => {
  it("renders Skills as a grouped read-only catalog instead of transcript prose", () => {
    const onCancel = vi.fn();
    const panel = createTuiSkillsInspectionPanel(
      {
        skills: [
          {
            name: "docs",
            displayName: "Docs",
            displayDescription:
              "Read project documentation and explain repository conventions, architecture, testing, release workflows, and every additional detail before THIRD-LINE-SENTINEL.",
            sourceKind: "builtin-agent",
            enabled: true,
          },
          {
            name: "release-notes",
            description: "Prepare a release summary",
            sourceKind: "workspace",
            enabled: false,
          },
        ],
        hasMore: true,
      },
      "doc",
      onCancel,
      () => 40,
    );

    const rendered = stripVTControlCharacters(panel.render(80).join("\n"));

    expect(rendered).toContain("Skills");
    expect(rendered).toContain("2+ FOUND");
    expect(rendered).toContain("Matching “doc”");
    expect(rendered).toContain("Built-in · 1");
    expect(rendered).toContain("User · 1");
    expect(rendered).toContain("Docs");
    expect(rendered).toContain("● available · builtin-agent");
    expect(rendered).toContain("Read project documentation");
    expect(rendered).toContain("○ unavailable · workspace");
    expect(rendered).toContain("read only · Esc close");
    expect(rendered).not.toContain("narrow the list with");

    const compact = stripVTControlCharacters(panel.render(50).join("\n"));
    expect(compact).toContain("…");
    expect(compact).not.toContain("THIRD-LINE-SENTINEL");

    panel.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("renders MCP servers by operational status with transport and safe detail", () => {
    const panel = createTuiMcpInspectionPanel(
      [
        {
          name: "matrix",
          enabled: false,
          available: false,
          status: "unavailable",
          sourceKind: "builtin",
          managed: true,
          transport: "stdio",
          description: "Built-in Matrix tools",
          error: "Built-in MCP server is not active in this Runtime.",
          tools: [
            { name: "web_search", description: "Search the web" },
            { name: "image_synthesize", description: "Create an image" },
            { name: "transcribe_audio", description: "Transcribe audio" },
          ],
        },
        {
          name: "browser",
          enabled: true,
          sourceKind: "configured",
          transport: "stdio",
          description: "Browser automation tools",
          configJson: '{"status":"available","secret":"do-not-render"}',
        },
        {
          name: "broken",
          enabled: true,
          sourceKind: "configured",
          transport: "sse",
          configJson:
            '{"status":"unavailable","error":"MCP server transport is incomplete. Configure a command or URL and retry. token=secret-value"}',
        },
      ],
      "",
      vi.fn(),
      () => 40,
    );

    const rendered = stripVTControlCharacters(panel.render(80).join("\n"));

    expect(rendered).toContain("MCP servers");
    expect(rendered).toContain("1/3 AVAILABLE");
    expect(rendered).toContain("Built-in · 1");
    expect(rendered).toContain("matrix");
    expect(rendered).toContain("○ unavailable · runtime-managed · 3 tools");
    expect(rendered).toContain(
      "web_search · image_synthesize · transcribe_audio",
    );
    expect(rendered).toContain("User-configured · 2");
    expect(rendered).toContain("broken");
    expect(rendered).toContain("! unavailable · sse");
    expect(rendered).toContain(
      "MCP server is unavailable. Retry or check its configuration.",
    );
    expect(rendered).not.toContain("secret-value");
    expect(rendered).toContain("browser");
    expect(rendered).toContain("● available · stdio");
    expect(rendered).toContain("Browser automation tools");
    expect(rendered).toContain("/mcp reload · Esc close");
    expect(rendered).not.toContain("do-not-render");
  });
});

describe("MCode context inspection", () => {
  it("shows when automatic compaction starts and which setting decides it", () => {
    // /context hard-coded the threshold to null, so this line never rendered.
    const inspection = createTuiContextInspection({
      status: "live",
      contextUsage: {
        contextWindowTokens: 10_000,
        usedTokens: 3_000,
        totalCountSource: "PROVIDER_USAGE_ANCHORED",
        components: [],
      },
      compactionTrigger: {
        providerId: "minimax",
        modelId: "MiniMax-M3",
        contextWindow: 10_000,
        builtInTriggerTokens: 7_600,
        effectiveTriggerTokens: 6_000,
        source: "model",
        saved: 6_000,
      },
    });
    const visualization = inspection?.visualization;
    if (visualization?.kind !== "context") throw new Error("Expected a context visualization.");
    const output = new ContextVisualization(visualization)
      .render(180)
      .map(stripVTControlCharacters)
      .join("\n");

    expect(output).toContain("Starts at 6k · 60% of window · 3k away · saved for this model");
  });
});
