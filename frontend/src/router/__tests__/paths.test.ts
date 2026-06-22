import { describe, expect, it } from "vitest";
import { AGENT_SECTION_PATH_BY_ID, getAgentSectionFromSlug } from "@/router/paths";

describe("agent route paths", () => {
  it("maps the hidden WebUI browser section to /agents/browser", () => {
    expect(AGENT_SECTION_PATH_BY_ID.browser).toBe("/agents/browser");
    expect(getAgentSectionFromSlug("browser")).toBe("browser");
  });

  it("maps the experts section to /agents/experts", () => {
    expect(AGENT_SECTION_PATH_BY_ID.expert).toBe("/agents/experts");
    expect(getAgentSectionFromSlug("experts")).toBe("expert");
  });
});
