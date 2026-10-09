import { describe, expect, it } from "vitest";

import {
  LOCAL_SKILL_DESCRIPTION_MAX_CODE_POINTS,
  renderLocalSkillsCatalogResult,
} from "../../src/skills/catalog.js";

describe("local skills catalog description cap", () => {
  it("caps ordinary skill descriptions at 300 code points", () => {
    expect(LOCAL_SKILL_DESCRIPTION_MAX_CODE_POINTS).toBe(300);
    const result = renderLocalSkillsCatalogResult([
      { name: "long-skill", description: "x".repeat(1_000), builtin: true },
    ]);
    expect(result.descriptionCapTruncated).toBe(true);
    expect(result.catalog).toContain("x".repeat(300));
    expect(result.catalog).not.toContain("x".repeat(301));
  });

  it("keeps descriptions at the cap intact and never trims protected skills", () => {
    const result = renderLocalSkillsCatalogResult([
      { name: "fits", description: "y".repeat(300), builtin: true },
      { name: "minimax-code-product", description: "p".repeat(900), builtin: true },
    ]);
    expect(result.descriptionCapTruncated).toBe(false);
    expect(result.catalog).toContain("y".repeat(300));
    expect(result.catalog).toContain("p".repeat(900));
  });
});
