import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("AgentWebsitePanel loading boundary", () => {
  it("uses the centered page loading primitive for the initial request", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/marketing/agent-website-panel.tsx"), "utf8");

    expect(source).toContain("AgentPageLoadingState");
  });
});
