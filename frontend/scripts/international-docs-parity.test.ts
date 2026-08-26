import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../next-site/source", () => ({ source: {} }));

import * as DocsLayoutModule from "../next-site/docs-layout";
import * as DocsPageModule from "../next-site/docs-page";
import { DOCS_ROUTE_SLUGS } from "../next-site/docs-route-manifest";
import { DOCS_STATIC_ROUTE_SLUGS } from "../next-site/docs-static-route-manifest";
import * as DocsRouteModule from "../src/app/(site)/[lang]/docs/[[...slug]]/page.intl";
import * as SyncDocsModule from "./sync-fumadocs-content.mjs";

const ACTIVE_SHARED_FILES = [
  "configuration/diagnostics.md",
  "configuration/files.md",
  "configuration/memory.md",
  "configuration/multiple-models.md",
  "create-first-hermes.md",
  "credits.md",
  "plans.md",
  "use-cases/chinese-messaging-channels.md",
  "use-cases/daily-summary.md",
  "use-cases/hermes-agent-24-7.md",
  "use-cases/im-agent-persona-soul-md.md",
  "use-cases/im-agent-skill-scenarios.md",
  "use-cases/memory-and-knowledge.md",
  "use-cases/multi-channel-personality-memory.md",
  "use-cases/personal-ai-assistant.md",
  "use-cases/telegram-persona-agent.md",
  "use-cases/telegram-group-community-assistant.md",
  "use-cases/whatsapp-24-7-customer-service.md",
  "use-cases/whatsapp-persona-agent.md",
  "use-cases/lifelike-im-agent-rhythm-social-memory.md",
  "use-cases/telegram-whatsapp-safety-boundaries.md",
  "who-is-lightvela-for.md",
] as const;

const LOCALE_SENSITIVE_USE_CASE_FILES = [
  "use-cases/chinese-messaging-channels.md",
  "use-cases/daily-summary.md",
  "use-cases/hermes-agent-24-7.md",
  "use-cases/im-agent-persona-soul-md.md",
  "use-cases/im-agent-skill-scenarios.md",
  "use-cases/memory-and-knowledge.md",
  "use-cases/multi-channel-personality-memory.md",
  "use-cases/telegram-persona-agent.md",
  "use-cases/telegram-group-community-assistant.md",
  "use-cases/whatsapp-24-7-customer-service.md",
  "use-cases/whatsapp-persona-agent.md",
  "use-cases/lifelike-im-agent-rhythm-social-memory.md",
  "use-cases/telegram-whatsapp-safety-boundaries.md",
] as const;

const HERMES_DEEP_DIVE_FILES = [
  "hermes-agent/01-hermes-vs-openclaw.md",
  "hermes-agent/02-why-hermes-remembers-you.md",
  "hermes-agent/03-user-md-vs-memory-md.md",
  "hermes-agent/04-hermes-memory-curation.md",
  "hermes-agent/05-memory-vs-skill.md",
  "hermes-agent/06-model-vs-agent-layer.md",
  "hermes-agent/07-message-gateway.md",
  "hermes-agent/08-automation-scheduling.md",
  "hermes-agent/09-model-switching-memory.md",
  "hermes-agent/10-persona-user-memory.md",
  "hermes-agent/11-workspace-context-storage.md",
  "hermes-agent/12-skills-self-improvement.md",
] as const;

const FULLY_LOCALIZED_CONFIGURATION_FILES = [
  "configuration/personality.md",
] as const;

const PUBLISHED_INTERNATIONAL_LOCALES = ["en-us", "zh-sg", "zh-hant", "id-id"] as const;

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
const generatedDocsRoot = join(process.cwd(), ".fumadocs-content", "docs");
const repoRoot = process.env.GUARD_REPO_ROOT ?? join(process.cwd(), "..");
const stashRoot = join(
  repoRoot,
  "docs",
  "international-doc-stash",
  "2026-07-23",
  "rehidden-2026-07-24",
);

const toRouteSlug = (file: string) => {
  if (file === "07-faq.md") return ["faq"];
  const segments = file.replace(/\.md$/, "").split("/");
  const fileName = segments.at(-1)?.replace(/^\d+-/, "");
  if (fileName) segments[segments.length - 1] = fileName;
  return segments.at(-1) === "index" ? segments.slice(0, -1) : segments;
};

const hasRoute = (locale: "en-us" | "zh-sg" | "zh-hant" | "id-id", file: string) =>
  DOCS_ROUTE_SLUGS[locale].some((slug) => slug.join("/") === toRouteSlug(file).join("/"));

const hasStaticRoute = (locale: "en-us" | "zh-sg" | "zh-hant" | "id-id", file: string) =>
  DOCS_STATIC_ROUTE_SLUGS[locale].some((slug) => slug.join("/") === toRouteSlug(file).join("/"));

const docsRouteSlugs = DOCS_ROUTE_SLUGS as unknown as Record<string, readonly (readonly string[])[]>;

const syncDocsApi = SyncDocsModule as unknown as {
  normalizeMarkdownLinks?: (markdown: string, currentFile: string, outputPrefix: string, locale: string) => string;
  stripTitle?: (markdown: string, title: string, stripSourceHeading?: boolean) => string;
};

const docsRouteApi = DocsRouteModule as unknown as {
  docsRouteLocalesForRegion?: (region: "cn" | "global") => readonly string[];
  publicLocaleForDocsRoute?: (locale: string) => string;
};

const docsPageApi = DocsPageModule as unknown as {
  docsBreadcrumbName?: (locale: string | undefined) => string;
};

const docsLayoutApi = DocsLayoutModule as unknown as {
  fumadocsTranslations?: (locale: string | undefined) => Record<string, string> | undefined;
};

const walkFiles = (root: string): string[] =>
  readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? walkFiles(path) : [path];
  });

const frontmatterValue = (content: string, key: string) => {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match?.[1]) return "";
  return JSON.parse(match[1]) as string;
};

const spanishDocsTargets = (content: string): string[] => {
  const targets: string[] = [];
  for (const match of content.matchAll(/(?<!!)\[[^\]\n]+]\((\S+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g)) {
    const href = match[1];
    if (!href) continue;
    const path = href.split(/[?#]/, 1)[0] ?? "";
    if (path !== "/es/docs" && !path.startsWith("/es/docs/")) continue;
    targets.push(path.slice("/es/docs".length).replace(/^\//, "").replace(/\/$/, ""));
  }
  return targets;
};

describe("international docs publication inventory", () => {
  it("keeps completed shared documents active in both languages", () => {
    for (const file of ACTIVE_SHARED_FILES) {
      expect(existsSync(join(docsContentRoot, "global", file)), `missing global/${file}`).toBe(true);
      expect(existsSync(join(docsContentRoot, "en", file)), `missing en/${file}`).toBe(true);
      expect(hasRoute("zh-sg", file), `missing zh-sg route for ${file}`).toBe(true);
      expect(hasRoute("en-us", file), `missing en-us route for ${file}`).toBe(true);
    }
  });

  it("publishes the Hermes Agent Deep Dive series in both languages", () => {
    for (const file of HERMES_DEEP_DIVE_FILES) {
      expect(existsSync(join(docsContentRoot, "global", file)), `missing global/${file}`).toBe(true);
      expect(existsSync(join(docsContentRoot, "en", file)), `missing en/${file}`).toBe(true);
      expect(hasRoute("zh-sg", file), `missing zh-sg route for ${file}`).toBe(true);
      expect(hasRoute("en-us", file), `missing en-us route for ${file}`).toBe(true);
    }
  });

  it("publishes fully localized configuration pages in every international locale", () => {
    for (const file of FULLY_LOCALIZED_CONFIGURATION_FILES) {
      expect(existsSync(join(docsContentRoot, "en", file)), `missing en/${file}`).toBe(true);
      expect(existsSync(join(docsContentRoot, "global", file)), `missing global/${file}`).toBe(true);
      expect(existsSync(join(docsContentRoot, "id", file)), `missing id/${file}`).toBe(true);
      for (const locale of PUBLISHED_INTERNATIONAL_LOCALES) {
        expect(hasRoute(locale, file), `missing ${locale} route for ${file}`).toBe(true);
        expect(hasStaticRoute(locale, file), `missing static ${locale} route for ${file}`).toBe(true);
      }
    }
  });

  it("keeps translated use-case internal links locale-relative", () => {
    for (const locale of ["global", "en"] as const) {
      for (const file of LOCALE_SENSITIVE_USE_CASE_FILES) {
        const path = join(docsContentRoot, locale, file);
        expect(readFileSync(path, "utf8"), `${locale}/${file} contains a locale-less docs URL`).not.toMatch(
          /https:\/\/lightvela\.ai\/docs\//,
        );
      }
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

  describe("Spanish docs fallback publication", () => {
    const esRoot = join(generatedDocsRoot, "es");

    it("publishes the same 62 routes as international English without exposing hidden locales", () => {
      expect(docsRouteSlugs.es).toEqual(docsRouteSlugs["en-us"]);
      expect(docsRouteSlugs.es).toHaveLength(62);
      expect(docsRouteSlugs.es).toContainEqual([]);
      expect(Object.keys(docsRouteSlugs)).not.toContain("ja-jp");
      expect(Object.keys(docsRouteSlugs)).not.toContain("ko-kr");
    });

    it("keeps all existing locale route inventories unchanged", () => {
      expect(docsRouteSlugs["en-us"]).toHaveLength(62);
      expect(docsRouteSlugs["zh-cn"]).toHaveLength(42);
      expect(docsRouteSlugs["zh-sg"]).toHaveLength(62);
      expect(docsRouteSlugs["zh-hant"]).toHaveLength(62);
      expect(docsRouteSlugs["id-id"]).toHaveLength(60);
    });

    it("generates 61 Spanish metadata wrappers from English or global sources without Spanish body files", () => {
      expect(existsSync(join(docsContentRoot, "es"))).toBe(false);
      expect(existsSync(esRoot)).toBe(true);

      const generatedDocs = walkFiles(esRoot).filter((path) => path.endsWith(".mdx"));
      expect(generatedDocs).toHaveLength(61);

      for (const path of generatedDocs) {
        const content = readFileSync(path, "utf8");
        const sourcePath = frontmatterValue(content, "source_path");
        expect(sourcePath, path).toMatch(/^src\/content\/docs\/(?:en|global)\//);
        expect(sourcePath, path).not.toContain("/es/");
        expect(frontmatterValue(content, "title"), path).not.toBe("");
        expect(frontmatterValue(content, "description"), path).not.toBe("");
      }

      for (const slug of ["overview", "configuration/model"]) {
        const content = readFileSync(join(esRoot, `${slug}.mdx`), "utf8");
        expect(frontmatterValue(content, "source_path")).toMatch(/^src\/content\/docs\/en\//);
      }
    });

    it("uses Spanish page and navigation metadata for all seven populated groups", () => {
      const overview = readFileSync(join(esRoot, "overview.mdx"), "utf8");
      expect(frontmatterValue(overview, "title")).toBe("Qué es LightVela");
      expect(frontmatterValue(overview, "description")).toBe(
        "LightVela es un compañero Hermes Agent alojado en la nube que mantiene activas tus conversaciones y automatizaciones.",
      );

      const personality = readFileSync(join(esRoot, "configuration/personality.mdx"), "utf8");
      expect(frontmatterValue(personality, "title")).toBe("Personalidad");
      expect(frontmatterValue(personality, "description")).toBe(
        "Elige y aplica una personalidad Soul para definir el rol, la voz, las prioridades y los límites de comportamiento de Hermes Agent.",
      );

      const meta = JSON.parse(readFileSync(join(esRoot, "meta.json"), "utf8")) as {
        title: string;
        pages: string[];
      };
      expect(meta.title).toBe("Documentación de LightVela");
      expect(meta.pages.filter((page) => page.startsWith("---"))).toEqual([
        "---Primeros pasos---",
        "---Planes y activación---",
        "---Funciones y configuración---",
        "---Casos de uso---",
        "---Comparar y elegir---",
        "---Análisis de Hermes Agent---",
        "---Soporte---",
      ]);
    });

    it("strips the English source H1 while preserving the English fallback body", () => {
      const overview = readFileSync(join(esRoot, "overview.mdx"), "utf8");
      const model = readFileSync(join(esRoot, "configuration", "model.mdx"), "utf8");
      expect(overview).not.toMatch(/^# What is LightVela$/m);
      expect(model).not.toMatch(/^# Configure Models$/m);
      expect(overview).toContain("A cloud-hosted Hermes Agent that understands you better over time.");
      expect(model).toContain("## Three configuration methods");
    });

    it.each([
      ["BOM", "\uFEFF# English source title\n\nBody"],
      ["leading blank lines", "\n\n# English source title\n\nBody"],
      ["BOM and leading blank lines", "\uFEFF \n\t\n# English source title\n\nBody"],
    ])("strips an ATX source H1 after %s", (_label, markdown) => {
      expect(syncDocsApi.stripTitle).toBeTypeOf("function");
      if (!syncDocsApi.stripTitle) return;
      expect(syncDocsApi.stripTitle(markdown, "Título en español", true)).toBe("Body");
    });

    it("rewrites generator link fixtures while preserving query, fragment, and title", () => {
      expect(syncDocsApi.normalizeMarkdownLinks).toBeTypeOf("function");
      if (!syncDocsApi.normalizeMarkdownLinks) return;

      const fixture = [
        '[relative](./02-quickstart.md?from=docs#setup "Inicio rápido")',
        "[fragment](./04-core-concepts.md#models)",
        "[title](./plans.md 'Planes')",
        "[root](/docs)",
        '[absolute](https://lightvela.ai/docs/configuration/model?from=guide#keys "Modelos")',
        "[./plans.md?from=docs](./plans.md?from=docs)",
        "[https://lightvela.ai/docs/overview](https://lightvela.ai/docs/overview)",
        '[missing](./missing.md?from=docs "No existe")',
      ].join("\n");

      expect(syncDocsApi.normalizeMarkdownLinks(fixture, "01-overview.md", "es", "es")).toBe(
        [
          '[relative](/es/docs/quickstart?from=docs#setup "Inicio rápido")',
          "[fragment](/es/docs/core-concepts#models)",
          "[title](/es/docs/plans 'Planes')",
          "[root](/es/docs)",
          '[absolute](/es/docs/configuration/model?from=guide#keys "Modelos")',
          "[./plans.md?from=docs](/es/docs/plans?from=docs)",
          "[https://lightvela.ai/docs/overview](/es/docs/overview)",
          '[missing](./missing.md?from=docs "No existe")',
        ].join("\n"),
      );
    });

    it("imports generator helpers without touching generated content or the tracked manifest", () => {
      const markerPath = join(generatedDocsRoot, ".helper-import-marker");
      const manifestPath = join(process.cwd(), "next-site", "docs-route-manifest.ts");
      const manifestBefore = readFileSync(manifestPath, "utf8");
      const manifestMtimeBefore = statSync(manifestPath, { bigint: true }).mtimeNs;
      writeFileSync(markerPath, "keep", "utf8");

      try {
        const moduleUrl = pathToFileURL(join(process.cwd(), "scripts", "sync-fumadocs-content.mjs")).href;
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl)});`],
          { cwd: process.cwd(), stdio: "pipe" },
        );

        expect(readFileSync(markerPath, "utf8")).toBe("keep");
        expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
        expect(statSync(manifestPath, { bigint: true }).mtimeNs).toBe(manifestMtimeBefore);
      } finally {
        rmSync(markerPath, { force: true });
      }
    });

    it("extracts manifest target paths from Spanish links with query, fragment, and title", () => {
      expect(
        spanishDocsTargets(
          [
            '[query](/es/docs/plans?from=docs "Planes")',
            "[fragment](/es/docs/configuration/model#keys)",
            "[both](/es/docs/overview?from=docs#summary)",
            "[root](/es/docs?from=docs#top)",
          ].join("\n"),
        ),
      ).toEqual(["plans", "configuration/model", "overview", ""]);
    });

    it("localizes every generated docs link and only targets Spanish manifest slugs", () => {
      const routeSet = new Set(docsRouteSlugs.es.map((slug) => slug.join("/")));
      const generatedDocs = walkFiles(esRoot).filter((path) => path.endsWith(".mdx"));

      for (const path of generatedDocs) {
        const content = readFileSync(path, "utf8");
        expect(content, path).not.toMatch(/]\(https:\/\/lightvela\.ai\/docs(?:\/|\))/);
        expect(content, path).not.toMatch(/]\(\/docs(?:\/|\))/);
        expect(content, path).not.toMatch(/]\([^)]*\.md(?:[)#])/);

        for (const target of spanishDocsTargets(content)) {
          expect(routeSet.has(target), `${path} links to missing /es/docs/${target}`).toBe(true);
        }
      }
    });

    it("selects available English image variants for the English fallback body", () => {
      const overview = readFileSync(join(esRoot, "overview.mdx"), "utf8");
      expect(overview).toContain("/docs-images/1-1-en.webp");
      expect(overview).toContain("/docs-images/1-2-en.webp");
      expect(overview).not.toContain("/docs-images/1-1.webp");
    });

    it("maps Spanish only into the global docs route collection and keeps CN zh-cn-only", () => {
      expect(docsRouteApi.docsRouteLocalesForRegion).toBeTypeOf("function");
      expect(docsRouteApi.publicLocaleForDocsRoute).toBeTypeOf("function");
      if (!docsRouteApi.docsRouteLocalesForRegion || !docsRouteApi.publicLocaleForDocsRoute) return;

      expect(docsRouteApi.docsRouteLocalesForRegion("global")).toEqual([
        "zh-sg",
        "zh-hant",
        "id-id",
        "es",
      ]);
      expect(docsRouteApi.docsRouteLocalesForRegion("cn")).toEqual([]);
      expect(docsRouteApi.publicLocaleForDocsRoute("es")).toBe("es");
      expect(docsRouteApi.docsRouteLocalesForRegion("global")).not.toContain("ja-jp");
      expect(docsRouteApi.docsRouteLocalesForRegion("global")).not.toContain("ko-kr");
    });

    it("returns Spanish breadcrumb, search, and table-of-contents controls", () => {
      expect(docsPageApi.docsBreadcrumbName).toBeTypeOf("function");
      expect(docsLayoutApi.fumadocsTranslations).toBeTypeOf("function");
      if (!docsPageApi.docsBreadcrumbName || !docsLayoutApi.fumadocsTranslations) return;

      expect(docsPageApi.docsBreadcrumbName("es")).toBe("Documentación");
      expect(docsLayoutApi.fumadocsTranslations("es")).toEqual({
        "Close Search(search dialog)(aria-label)": "Cerrar búsqueda",
        "No Headings(table of contents)": "No hay encabezados",
        "No results found(search dialog)": "No se encontraron resultados",
        "On this page(table of contents)": "En esta página",
        "Open Search(search trigger)(aria-label)": "Abrir búsqueda",
        "Search(search dialog)": "Buscar",
        "Search(search trigger)": "Buscar documentación",
      });
    });
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
