import { describe, expect, it } from "vitest";

import {
  AGENT_LAB_SECTION_ID_BY_SLUG,
  AGENT_SECTION_PATH_BY_ID,
  getAgentCreatingPath,
  getAgentLabSectionFromSlug,
  getAgentSectionFromSlug,
  getAgentSectionHref,
  shouldShowWorkbenchEntry,
} from "@/lib/agent-routes";

describe("agent route constants", () => {
  it("keeps shareable agent section urls outside the deleted vite router", () => {
    expect(AGENT_SECTION_PATH_BY_ID.browser).toBe("/agents/browser");
    expect(AGENT_SECTION_PATH_BY_ID.settings).toBe("/agents/settings");
    expect(AGENT_SECTION_PATH_BY_ID.workbench).toBe("/agents/workbench");
    expect(getAgentSectionFromSlug("browser")).toBe("browser");
    expect(getAgentSectionFromSlug("workbench")).toBe("workbench");
    expect(getAgentSectionFromSlug("session")).toBe("workbench");
    expect(getAgentSectionFromSlug("settings")).toBe("settings");
    expect(getAgentSectionFromSlug("unknown")).toBeNull();
  });

  it("keeps DeepSeek Harness behind the nested labs route", () => {
    expect(AGENT_SECTION_PATH_BY_ID["deepseek-harness"]).toBe(
      "/agents/labs/deepseek-harness",
    );
    expect(AGENT_LAB_SECTION_ID_BY_SLUG["deepseek-harness"]).toBe(
      "deepseek-harness",
    );
    expect(getAgentLabSectionFromSlug("deepseek-harness")).toBe(
      "deepseek-harness",
    );
    expect(getAgentLabSectionFromSlug("unknown")).toBeNull();
    expect(getAgentSectionFromSlug("deepseek-harness")).toBeNull();
  });

  it("hides the workbench entry on public hosts by default", () => {
    expect(shouldShowWorkbenchEntry({ hostname: "lightclaw.tech", revealed: false })).toBe(false);
    expect(shouldShowWorkbenchEntry({ hostname: "lightclaw.pages.dev", revealed: false })).toBe(false);
  });

  it("shows the workbench entry on local development hosts", () => {
    expect(shouldShowWorkbenchEntry({ hostname: "127.0.0.1", revealed: false })).toBe(true);
    expect(shouldShowWorkbenchEntry({ hostname: "localhost", revealed: false })).toBe(true);
    expect(shouldShowWorkbenchEntry({ hostname: "::1", revealed: false })).toBe(true);
  });

  it("shows the workbench entry after the console reveal hook runs", () => {
    expect(shouldShowWorkbenchEntry({ hostname: "lightclaw.tech", revealed: true })).toBe(true);
  });

  it("builds the agent creating url with the requested instance id", () => {
    expect(getAgentCreatingPath("ins-123")).toBe("/agents?creating=ins-123");
    expect(getAgentCreatingPath(true)).toBe("/agents?creating=true");
  });

  it("does not carry creation flow params into agent section routes", () => {
    expect(
      getAgentSectionHref(
        AGENT_SECTION_PATH_BY_ID.model,
        new URLSearchParams("creating=ins-123&plan=bundle_cruise_01&from=subscribe"),
      ),
    ).toBe("/agents/models");
  });
});
