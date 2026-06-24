import { describe, expect, it } from "vitest";

import {
  AGENT_SECTION_PATH_BY_ID,
  getAgentSectionFromSlug,
  shouldShowWorkbenchEntry,
} from "@/lib/agent-routes";

describe("agent route constants", () => {
  it("keeps shareable agent section urls outside the deleted vite router", () => {
    expect(AGENT_SECTION_PATH_BY_ID.browser).toBe("/agents/browser");
    expect(AGENT_SECTION_PATH_BY_ID.workbench).toBe("/agents/workbench");
    expect(getAgentSectionFromSlug("browser")).toBe("browser");
    expect(getAgentSectionFromSlug("workbench")).toBe("workbench");
    expect(getAgentSectionFromSlug("session")).toBe("workbench");
    expect(getAgentSectionFromSlug("unknown")).toBeNull();
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
});
