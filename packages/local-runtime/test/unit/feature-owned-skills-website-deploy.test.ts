import { resolveAgentCapabilities } from "@mavis/config";
import { describe, expect, it } from "vitest";

import {
  hasManagedAccountSession,
  resolveFeatureAwareBuiltinSkillNames,
} from "../../src/agent/feature-owned-skills.js";

const gates = { cuModeActive: false };

describe("website deploy skill gating", () => {
  const capabilities = resolveAgentCapabilities();

  it("keeps the deploy skills when the capability config alone decides", () => {
    const names = resolveFeatureAwareBuiltinSkillNames(capabilities, gates);
    expect(names).toContain("deploy-website");
    expect(names).toContain("edit-deployed-website");
  });

  it("keeps the deploy skills when website_deploy is wired", () => {
    const names = resolveFeatureAwareBuiltinSkillNames(capabilities, {
      ...gates,
      websiteDeployAvailable: true,
    });
    expect(names).toContain("deploy-website");
    expect(names).toContain("edit-deployed-website");
  });

  it("drops the deploy skills when website_deploy is not wired", () => {
    const names = resolveFeatureAwareBuiltinSkillNames(capabilities, {
      ...gates,
      websiteDeployAvailable: false,
    });
    expect(names).not.toContain("deploy-website");
    expect(names).not.toContain("edit-deployed-website");
    expect(names).toContain("code-review");
  });
});

describe("hasManagedAccountSession", () => {
  it("requires a non-blank access token", () => {
    expect(hasManagedAccountSession(undefined)).toBe(false);
    expect(hasManagedAccountSession({})).toBe(false);
    expect(hasManagedAccountSession({ accessToken: "  " })).toBe(false);
    expect(hasManagedAccountSession({ accessToken: "tok" })).toBe(true);
  });
});
