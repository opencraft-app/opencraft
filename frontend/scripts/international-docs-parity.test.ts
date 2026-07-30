import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DOCS_ROUTE_SLUGS } from "../next-site/docs-route-manifest";
import { DOCS_STATIC_ROUTE_SLUGS } from "../next-site/docs-static-route-manifest";

const ACTIVE_SHARED_FILES = [
  "configuration/diagnostics.md",
  "configuration/files.md",
  "configuration/memory.md",
  "configuration/multiple-models.md",
  "create-first-hermes.md",
  "credits.md",
  "plans.md",
  "use-cases/personal-ai-assistant.md",
  "use-cases/chinese-messaging-channels.md",
  "use-cases/daily-summary.md",
  "use-cases/hermes-agent-24-7.md",
  "use-cases/memory-and-knowledge.md",
  "who-is-lightvela-for.md",
] as const;

const STASHED_SHARED_FILES = [
  "07-faq.md",
  "advanced/agent-workflow-design.md",
  "advanced/automation-fit.md",
  "advanced/models-skills-automation.md",
  "advanced/multi-channel-hermes.md",
  "advanced/reduce-model-cost.md",
  "security/data-protection.md",
  "security/data-storage.md",
  "security/export-and-delete-data.md",
  "security/instance-isolation.md",
  "security/model-training-policy.md",
  "support/report-an-issue.md",
  "troubleshooting/agent-not-responding.md",
  "troubleshooting/automation-not-running.md",
  "troubleshooting/channel-connection-failed.md",
  "troubleshooting/model-errors.md",
  "troubleshooting/rebuild-hermes.md",
  "troubleshooting/skill-installation-failed.md",
] as const;

const docsContentRoot = join(process.cwd(), "src", "content", "docs");
const stashRoot = join(
  process.cwd(),
  "..",
  "docs",
  "international-doc-stash",
  "2026-07-23",
  "rehidden-2026-07-24",
);

const toRouteSlug = (file: string) => {
  if (file === "07-faq.md") return ["faq"];
  const segments = file.replace(/\.md$/, "").split("/");
  return segments.at(-1) === "index" ? segments.slice(0, -1) : segments;
};

const hasRoute = (locale: "en-us" | "zh-sg", file: string) =>
  DOCS_ROUTE_SLUGS[locale].some((slug) => slug.join("/") === toRouteSlug(file).join("/"));

const hasStaticRoute = (locale: "en-us" | "zh-sg", file: string) =>
  DOCS_STATIC_ROUTE_SLUGS[locale].some((slug) => slug.join("/") === toRouteSlug(file).join("/"));

describe("international docs publication inventory", () => {
  it("keeps completed shared documents active in both languages", () => {
    for (const file of ACTIVE_SHARED_FILES) {
      expect(existsSync(join(docsContentRoot, "global", file)), `missing global/${file}`).toBe(true);
      expect(existsSync(join(docsContentRoot, "en", file)), `missing en/${file}`).toBe(true);
      expect(hasRoute("zh-sg", file), `missing zh-sg route for ${file}`).toBe(true);
      expect(hasRoute("en-us", file), `missing en-us route for ${file}`).toBe(true);
    }
  });

  it("keeps unfinished international documents stashed and unpublished", () => {
    for (const file of STASHED_SHARED_FILES) {
      expect(existsSync(join(docsContentRoot, "global", file)), `active global/${file}`).toBe(false);
      expect(existsSync(join(docsContentRoot, "en", file)), `active en/${file}`).toBe(false);
      expect(existsSync(join(stashRoot, "global", file)), `missing stash global/${file}`).toBe(true);
      expect(existsSync(join(stashRoot, "en", file)), `missing stash en/${file}`).toBe(true);
      expect(hasRoute("zh-sg", file), `published zh-sg route for ${file}`).toBe(false);
      expect(hasRoute("en-us", file), `published en-us route for ${file}`).toBe(false);
      expect(hasStaticRoute("zh-sg", file), `static zh-sg route for ${file}`).toBe(false);
      expect(hasStaticRoute("en-us", file), `static en-us route for ${file}`).toBe(false);
    }
  });

  it("registers the docs root path for both international locales", () => {
    expect(DOCS_ROUTE_SLUGS["en-us"]).toContainEqual([]);
    expect(DOCS_ROUTE_SLUGS["zh-sg"]).toContainEqual([]);
  });

  for (const locale of ["global", "en"] as const) {
    for (const file of ["plans.md", "create-first-hermes.md"] as const) {
      it(`${locale}: ${file} does not reference the deprecated asset`, () => {
        const path = join(docsContentRoot, locale, file);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).not.toContain("20260721-150502-8b3a.webp");
      });
    }
  }
});
