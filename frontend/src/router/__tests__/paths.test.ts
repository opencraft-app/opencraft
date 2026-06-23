import { describe, expect, it } from "vitest";
import { AGENT_SECTION_PATH_BY_ID, getAgentSectionFromSlug } from "@/router/paths";

describe("agent route paths", () => {
  it("maps the hidden WebUI browser section to /agents/browser", () => {
    expect(AGENT_SECTION_PATH_BY_ID.browser).toBe("/agents/browser");
    expect(getAgentSectionFromSlug("browser")).toBe("browser");
  });

  it("aliases the legacy experts section to the skills page", () => {
    expect(AGENT_SECTION_PATH_BY_ID.skill).toBe("/agents/skills");
    expect(getAgentSectionFromSlug("experts")).toBe("skill");
  });
});
