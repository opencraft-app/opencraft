import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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

const markdownFilesRelativeTo = (root: string): string[] =>
  existsSync(root)
    ? walkFiles(root)
        .filter((path) => path.endsWith(".md"))
        .map((path) => relative(root, path))
        .sort()
    : [];

const fencedCodeBlocks = (content: string): string[] =>
  Array.from(content.matchAll(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm), (match) => match[0]);

const withoutFencedCode = (content: string): string =>
  content.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");

const imageTargets = (content: string): string[] => {
  const body = withoutFencedCode(content);
  const markdownTargets = Array.from(body.matchAll(/!\[[^\]]*]\(([^\s)]+)(?:\s+[^)]*)?\)/g), (match) => match[1]);
  const htmlTargets = Array.from(body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi), (match) => match[1]);
  return [...markdownTargets, ...htmlTargets].filter((target): target is string => Boolean(target));
};

const linkTargets = (content: string): string[] =>
  Array.from(
    withoutFencedCode(content).matchAll(/(?<!!)\[[^\]]*]\(([^\s)]+)(?:\s+[^)]*)?\)/g),
    (match) => match[1],
  ).filter((target): target is string => Boolean(target));

const markdownStructure = (content: string) => {
  const body = withoutFencedCode(content);
  return {
    headingLevels: Array.from(body.matchAll(/^(#{1,6})\s+/gm), (match) => match[1]?.length ?? 0),
    tableSeparators: Array.from(body.matchAll(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm)).length,
    tableRows: Array.from(body.matchAll(/^\s*\|.*\|\s*$/gm)).length,
    unorderedListItems: Array.from(body.matchAll(/^\s*[-+*]\s+/gm)).length,
    orderedListItems: Array.from(body.matchAll(/^\s*\d+[.)]\s+/gm)).length,
    blockquoteLines: Array.from(body.matchAll(/^\s*>/gm)).length,
    horizontalRules: Array.from(body.matchAll(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm)).length,
  };
};

const frontmatterValue = (content: string, key: string) => {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match?.[1]) return "";
  return JSON.parse(match[1]) as string;
};

const localizedDocsTargets = (content: string, locale: "es" | "ja-jp" | "ko-kr"): string[] => {
  const targets: string[] = [];
  for (const match of content.matchAll(/(?<!!)\[[^\]\n]+]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g)) {
    const href = match[1];
    if (!href) continue;
    const path = href.split(/[?#]/, 1)[0] ?? "";
    const docsRoot = `/${locale}/docs`;
    if (path !== docsRoot && !path.startsWith(`${docsRoot}/`)) continue;
    targets.push(path.slice(docsRoot.length).replace(/^\//, "").replace(/\/$/, ""));
  }
  return targets;
};

const spanishDocsTargets = (content: string): string[] => localizedDocsTargets(content, "es");
const japaneseDocsTargets = (content: string): string[] => localizedDocsTargets(content, "ja-jp");
const koreanDocsTargets = (content: string): string[] => localizedDocsTargets(content, "ko-kr");

describe("international docs publication inventory", () => {
  describe("Spanish docs source parity", () => {
    const enRoot = join(docsContentRoot, "en");
    const esRoot = join(docsContentRoot, "es");

    it("keeps a complete Spanish source file for every international English document", () => {
      expect(markdownFilesRelativeTo(esRoot)).toEqual(markdownFilesRelativeTo(enRoot));
    });

    it("preserves images, fenced code, and document structure in every Spanish source", () => {
      for (const file of markdownFilesRelativeTo(esRoot)) {
        const english = readFileSync(join(enRoot, file), "utf8");
        const spanish = readFileSync(join(esRoot, file), "utf8");

        expect(imageTargets(spanish), `${file}: image targets changed`).toEqual(imageTargets(english));
        expect(linkTargets(spanish), `${file}: link targets changed`).toEqual(linkTargets(english));
        expect(fencedCodeBlocks(spanish), `${file}: fenced code changed`).toEqual(fencedCodeBlocks(english));
        expect(markdownStructure(spanish), `${file}: heading or table structure changed`).toEqual(
          markdownStructure(english),
        );
      }
    });

    it("keeps the Tencent Lighthouse team name unchanged in Spanish docs", () => {
      for (const file of markdownFilesRelativeTo(esRoot)) {
        const spanish = readFileSync(join(esRoot, file), "utf8");
        expect(spanish, `${file}: Tencent Lighthouse team name was rewritten`).not.toMatch(
          /Tencent Cloud Lighthouse|Tencent Cloud Light\b/,
        );
      }
    });
  });

  describe("Japanese docs source parity", () => {
    const enRoot = join(docsContentRoot, "en");
    const jaRoot = join(docsContentRoot, "ja");
    const generatedJaRoot = join(generatedDocsRoot, "ja-jp");

    it("keeps a complete Japanese source file for every international English document", () => {
      expect(markdownFilesRelativeTo(jaRoot)).toEqual(markdownFilesRelativeTo(enRoot));
    });

    it("preserves images, links, fenced code, and document structure in every Japanese source", () => {
      for (const file of markdownFilesRelativeTo(jaRoot)) {
        const english = readFileSync(join(enRoot, file), "utf8");
        const japanese = readFileSync(join(jaRoot, file), "utf8");

        expect(imageTargets(japanese), `${file}: image targets changed`).toEqual(imageTargets(english));
        expect(linkTargets(japanese), `${file}: link targets changed`).toEqual(linkTargets(english));
        expect(fencedCodeBlocks(japanese), `${file}: fenced code changed`).toEqual(fencedCodeBlocks(english));
        expect(markdownStructure(japanese), `${file}: heading or table structure changed`).toEqual(
          markdownStructure(english),
        );
        expect(japanese.match(/[ぁ-んァ-ヶ一-龠]/g)?.length ?? 0, `${file}: Japanese body is missing`).toBeGreaterThan(30);
      }
    });

    it("provides an international-only Japanese search endpoint", () => {
      const routeRoot = join(process.cwd(), "src", "app", "api", "search", "ja-jp");
      expect(existsSync(join(routeRoot, "route.intl.ts"))).toBe(true);
      expect(existsSync(join(routeRoot, "route.next.ts"))).toBe(false);
    });

    it("generates the same 67-route inventory as English from Japanese sources", () => {
      expect(docsRouteSlugs["ja-jp"]).toEqual(docsRouteSlugs["en-us"]);
      expect(docsRouteSlugs["ja-jp"]).toHaveLength(67);
      const generatedDocs = walkFiles(generatedJaRoot).filter((path) => path.endsWith(".mdx"));
      expect(generatedDocs).toHaveLength(66);
      for (const path of generatedDocs) {
        expect(frontmatterValue(readFileSync(path, "utf8"), "source_path"), path).toMatch(
          /^src\/content\/docs\/ja\//,
        );
      }
    });

    it("uses Japanese page, navigation, breadcrumb, and search controls", () => {
      const overview = readFileSync(join(generatedJaRoot, "overview.mdx"), "utf8");
      expect(frontmatterValue(overview, "title")).toBe("LightVelaとは何ですか");
      expect(frontmatterValue(overview, "description")).toContain("クラウドホスト型エージェントプラットフォーム");

      const meta = JSON.parse(readFileSync(join(generatedJaRoot, "meta.json"), "utf8")) as {
        title: string;
        pages: string[];
      };
      expect(meta.title).toBe("LightVelaドキュメント");
      expect(meta.pages.filter((page) => page.startsWith("---"))).toEqual([
        "---はじめに---",
        "---プランと利用開始---",
        "---機能と設定---",
        "---ユースケース---",
        "---比較と選び方---",
        "---Hermes Agentを深く知る---",
        "---サポート---",
      ]);

      expect(docsPageApi.docsBreadcrumbName?.("ja-jp")).toBe("ドキュメント");
      expect(docsLayoutApi.fumadocsTranslations?.("ja-jp")).toEqual({
        "Close Search(search dialog)(aria-label)": "検索を閉じる",
        "No Headings(table of contents)": "見出しはありません",
        "No results found(search dialog)": "結果が見つかりません",
        "On this page(table of contents)": "このページの内容",
        "Open Search(search trigger)(aria-label)": "検索を開く",
        "Search(search dialog)": "検索",
        "Search(search trigger)": "ドキュメントを検索",
      });
    });

    it("maps Japanese content and opens the public docs route", () => {
      expect(docsRouteApi.publicLocaleForDocsRoute?.("ja-jp")).toBe("ja-JP");
      expect(docsRouteApi.docsRouteLocalesForRegion?.("global")).toContain("ja-jp");
    });

    it("localizes every generated Japanese docs link to a real Japanese route", () => {
      const routeSet = new Set(docsRouteSlugs["ja-jp"].map((slug) => slug.join("/")));
      const generatedDocs = walkFiles(generatedJaRoot).filter((path) => path.endsWith(".mdx"));
      for (const path of generatedDocs) {
        const content = readFileSync(path, "utf8");
        expect(content, path).not.toMatch(/]\(https:\/\/lightvela\.ai\/docs(?:\/|\))/);
        expect(content, path).not.toMatch(/]\(\/docs(?:\/|\))/);
        expect(content, path).not.toMatch(/]\([^)]*\.md(?:[)#])/);
        for (const target of japaneseDocsTargets(content)) {
          expect(routeSet.has(target), `${path} links to missing /ja-jp/docs/${target}`).toBe(true);
        }
      }
    });
  });

  describe("Korean docs source parity", () => {
    const enRoot = join(docsContentRoot, "en");
    const koRoot = join(docsContentRoot, "ko");
    const generatedKoRoot = join(generatedDocsRoot, "ko-kr");

    it("keeps a complete Korean source file for every international English document", () => {
      expect(markdownFilesRelativeTo(koRoot)).toEqual(markdownFilesRelativeTo(enRoot));
    });

    it("preserves images, links, fenced code, and document structure in every Korean source", () => {
      for (const file of markdownFilesRelativeTo(koRoot)) {
        const english = readFileSync(join(enRoot, file), "utf8");
        const korean = readFileSync(join(koRoot, file), "utf8");

        expect(imageTargets(korean), `${file}: image targets changed`).toEqual(imageTargets(english));
        expect(linkTargets(korean), `${file}: link targets changed`).toEqual(linkTargets(english));
        expect(fencedCodeBlocks(korean), `${file}: fenced code changed`).toEqual(fencedCodeBlocks(english));
        expect(markdownStructure(korean), `${file}: heading or table structure changed`).toEqual(
          markdownStructure(english),
        );
        expect(korean.match(/[가-힣]/g)?.length ?? 0, `${file}: Korean body is missing`).toBeGreaterThan(30);
      }
    });

    it("rejects corrupted repetition and Chinese Han residue in Korean prose", () => {
      const repeatedWord = /([가-힣]+)(?:\s+\1){3,}/u;

      for (const file of markdownFilesRelativeTo(koRoot)) {
        const korean = withoutFencedCode(readFileSync(join(koRoot, file), "utf8"));
        expect(korean, `${file}: contains a runaway repeated Korean word`).not.toMatch(repeatedWord);
        expect(korean, `${file}: contains Chinese Han characters`).not.toMatch(/\p{Script=Han}/u);
      }
    });

    it("provides an international-only Korean search endpoint", () => {
      const routeRoot = join(process.cwd(), "src", "app", "api", "search", "ko-kr");
      expect(existsSync(join(routeRoot, "route.intl.ts"))).toBe(true);
      expect(existsSync(join(routeRoot, "route.next.ts"))).toBe(false);
    });

    it("generates the same 67-route inventory as English from Korean sources", () => {
      expect(docsRouteSlugs["ko-kr"]).toEqual(docsRouteSlugs["en-us"]);
      expect(docsRouteSlugs["ko-kr"]).toHaveLength(67);
      const generatedDocs = walkFiles(generatedKoRoot).filter((path) => path.endsWith(".mdx"));
      expect(generatedDocs).toHaveLength(66);
      for (const path of generatedDocs) {
        expect(frontmatterValue(readFileSync(path, "utf8"), "source_path"), path).toMatch(
          /^src\/content\/docs\/ko\//,
        );
      }
    });

    it("uses Korean navigation, breadcrumb, and search controls", () => {
      const meta = JSON.parse(readFileSync(join(generatedKoRoot, "meta.json"), "utf8")) as {
        title: string;
        pages: string[];
      };
      expect(meta.title).toBe("LightVela 문서");
      expect(meta.pages.filter((page) => page.startsWith("---"))).toEqual([
        "---시작하기---",
        "---플랜 및 시작---",
        "---기능 및 설정---",
        "---사용 사례---",
        "---비교 및 선택---",
        "---Hermes Agent 심층 분석---",
        "---지원---",
      ]);

      expect(docsPageApi.docsBreadcrumbName?.("ko-kr")).toBe("문서");
      expect(docsLayoutApi.fumadocsTranslations?.("ko-kr")).toEqual({
        "Close Search(search dialog)(aria-label)": "검색 닫기",
        "No Headings(table of contents)": "제목이 없습니다",
        "No results found(search dialog)": "검색 결과가 없습니다",
        "On this page(table of contents)": "이 페이지에서",
        "Open Search(search trigger)(aria-label)": "검색 열기",
        "Search(search dialog)": "검색",
        "Search(search trigger)": "문서 검색",
      });
    });

    it("maps Korean content and opens the public docs route", () => {
      expect(docsRouteApi.publicLocaleForDocsRoute?.("ko-kr")).toBe("ko-KR");
      expect(docsRouteApi.docsRouteLocalesForRegion?.("global")).toContain("ko-kr");
    });

    it("localizes every generated Korean docs link to a real Korean route", () => {
      const routeSet = new Set(docsRouteSlugs["ko-kr"].map((slug) => slug.join("/")));
      const generatedDocs = walkFiles(generatedKoRoot).filter((path) => path.endsWith(".mdx"));
      for (const path of generatedDocs) {
        const content = readFileSync(path, "utf8");
        expect(content, path).not.toMatch(/]\(https:\/\/lightvela\.ai\/docs(?:\/|\))/);
        expect(content, path).not.toMatch(/]\(\/docs(?:\/|\))/);
        expect(content, path).not.toMatch(/]\([^)]*\.md(?:[)#])/);
        for (const target of koreanDocsTargets(content)) {
          expect(routeSet.has(target), `${path} links to missing /ko-kr/docs/${target}`).toBe(true);
        }
      }
    });

    it("documents console skill removal consistently in English, Japanese, and Korean", () => {
      const english = readFileSync(join(enRoot, "configuration", "skill.md"), "utf8");
      const japanese = readFileSync(join(docsContentRoot, "ja", "configuration", "skill.md"), "utf8");
      const korean = readFileSync(join(koRoot, "configuration", "skill.md"), "utf8");

      expect(english).toContain("Installed skills can be removed from the console.");
      expect(english).not.toContain("Currently only conversation-based deletion is supported");
      expect(japanese).toContain("インストール済みのスキルはコンソールから削除できます");
      expect(japanese).not.toContain("現在は会話ベースでの削除のみサポートされています");
      expect(korean).toContain("설치한 스킬은 콘솔에서 삭제할 수 있습니다");
      expect(korean).not.toContain("현재 대화 기반 삭제만 지원됩니다");
    });
  });

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

  describe("Spanish docs source publication", () => {
    const esRoot = join(generatedDocsRoot, "es");

    it("publishes the same 67 routes as international English for every completed locale", () => {
      expect(docsRouteSlugs.es).toEqual(docsRouteSlugs["en-us"]);
      expect(docsRouteSlugs.es).toHaveLength(67);
      expect(docsRouteSlugs.es).toContainEqual([]);
      expect(Object.keys(docsRouteSlugs)).toContain("ja-jp");
      expect(Object.keys(docsRouteSlugs)).toContain("ko-kr");
    });

    it("keeps the expected locale route inventories", () => {
      expect(docsRouteSlugs["en-us"]).toHaveLength(67);
      expect(docsRouteSlugs["zh-cn"]).toHaveLength(43);
      expect(docsRouteSlugs["zh-sg"]).toHaveLength(67);
      expect(docsRouteSlugs["zh-hant"]).toHaveLength(67);
      expect(docsRouteSlugs["id-id"]).toHaveLength(65);
    });

    it("generates 66 Spanish documents from explicit Spanish body sources", () => {
      expect(existsSync(join(docsContentRoot, "es"))).toBe(true);
      expect(existsSync(esRoot)).toBe(true);

      const generatedDocs = walkFiles(esRoot).filter((path) => path.endsWith(".mdx"));
      expect(generatedDocs).toHaveLength(66);

      for (const path of generatedDocs) {
        const content = readFileSync(path, "utf8");
        const sourcePath = frontmatterValue(content, "source_path");
        expect(sourcePath, path).toMatch(/^src\/content\/docs\/es\//);
        expect(frontmatterValue(content, "title"), path).not.toBe("");
        expect(frontmatterValue(content, "description"), path).not.toBe("");
      }

      for (const slug of ["overview", "configuration/model"]) {
        const content = readFileSync(join(esRoot, `${slug}.mdx`), "utf8");
        expect(frontmatterValue(content, "source_path")).toMatch(/^src\/content\/docs\/es\//);
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

    it("strips the Spanish source H1 while preserving the Spanish body", () => {
      const overview = readFileSync(join(esRoot, "overview.mdx"), "utf8");
      const model = readFileSync(join(esRoot, "configuration", "model.mdx"), "utf8");
      expect(overview).not.toMatch(/^# What is LightVela$/m);
      expect(model).not.toMatch(/^# Configure Models$/m);
      expect(overview).toContain("Un Hermes Agent alojado en la nube que te entiende mejor con el tiempo.");
      expect(model).toMatch(/## (Tres métodos de configuración|Tres formas de configuración)/);
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

    it("maps all published international locales into global docs and keeps CN zh-cn-only", () => {
      expect(docsRouteApi.docsRouteLocalesForRegion).toBeTypeOf("function");
      expect(docsRouteApi.publicLocaleForDocsRoute).toBeTypeOf("function");
      if (!docsRouteApi.docsRouteLocalesForRegion || !docsRouteApi.publicLocaleForDocsRoute) return;

      expect(docsRouteApi.docsRouteLocalesForRegion("global")).toEqual([
        "zh-sg",
        "zh-hant",
        "id-id",
        "es",
        "ja-jp",
        "ko-kr",
      ]);
      expect(docsRouteApi.docsRouteLocalesForRegion("cn")).toEqual([]);
      expect(docsRouteApi.publicLocaleForDocsRoute("es")).toBe("es");
      expect(docsRouteApi.docsRouteLocalesForRegion("global")).toContain("ja-jp");
      expect(docsRouteApi.docsRouteLocalesForRegion("global")).toContain("ko-kr");
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
