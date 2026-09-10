import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceRoot = process.env.MONO2_FRONTEND_ROOT
  ? resolve(process.env.MONO2_FRONTEND_ROOT, "src")
  : "/data/mono2/frontend/src";
const sourceFrontendRoot = resolve(sourceRoot, "..");
const sourceRepositoryRoot = resolve(sourceFrontendRoot, "..");
const targetRoot = join(
  repositoryRoot,
  "plugins/lightvela-hermes/src/upstream/mono2",
);
const targetPublicRoot = join(repositoryRoot, "apps/workbench-web/public");

if (!existsSync(sourceRoot)) {
  throw new Error(`mono2 frontend source root does not exist: ${sourceRoot}`);
}

const sourcePublicRoot = join(sourceFrontendRoot, "public");
const sourceSkillsAssetRoot = join(sourcePublicRoot, "assets/skills");
if (!existsSync(sourceSkillsAssetRoot)) {
  throw new Error(`mono2 skills asset root does not exist: ${sourceSkillsAssetRoot}`);
}

const seeds = [
  "pages/marketing/agent-model-config/agent-model-config-panel.tsx",
  "pages/marketing/agent-model-config/product-provider-adapter.ts",
  "pages/marketing/agent-channel-panel.tsx",
  "pages/marketing/agent-skills-panel.tsx",
  "pages/marketing/agent-automations-panel.tsx",
  "pages/marketing/agent-memory.ts",
  "pages/marketing/agent-memory-save.ts",
  "pages/marketing/agent-diagnostics-panel.tsx",
  "components/domain/tat-file-manager-panel.tsx",
  "pages/marketing/agent-config/standard-panel.css",
];

const publicAssets = [
  "tat-hermes-web-proxy-sw.js",
  ...readdirSync(sourceSkillsAssetRoot)
    .sort()
    .map((name) => `assets/skills/${name}`),
];

const sourceExtensions = [".ts", ".tsx", ".css", ".json"];
const checkOnly = process.argv.includes("--check");

function resolveSourceImport(specifier, importer) {
  let base;
  if (specifier.startsWith("@/")) {
    base = join(sourceRoot, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(join(sourceRoot, importer)), specifier);
  } else {
    return null;
  }
  for (const candidate of [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => join(base, `index${extension}`)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(sourceRoot, candidate);
    }
  }
  return null;
}

function collectSourceClosure() {
  const queue = [...seeds];
  const closure = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || closure.has(file)) continue;
    const absolute = join(sourceRoot, file);
    if (!existsSync(absolute)) {
      throw new Error(`mono2 source is missing: ${absolute}`);
    }
    closure.add(file);
    if (![".ts", ".tsx"].includes(extname(file))) continue;
    const contents = readFileSync(absolute, "utf8");
    const importPattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of contents.matchAll(importPattern)) {
      const dependency = resolveSourceImport(match[1] ?? match[2], file);
      if (dependency && !closure.has(dependency)) queue.push(dependency);
    }
  }
  return [...closure].sort();
}

function localizeAliases(contents, file) {
  const localized = contents.replace(/(["'])@\/([^"']+)\1/g, (_match, quote, importedPath) => {
    const dependency = resolveSourceImport(`@/${importedPath}`, file);
    if (!dependency) return `${quote}@/${importedPath}${quote}`;
    let localized = relative(dirname(file), dependency).replaceAll("\\", "/");
    localized = localized.replace(/\.(?:tsx?|css|json)$/u, "");
    if (!localized.startsWith(".")) localized = `./${localized}`;
    return `${quote}${localized}${quote}`;
  });
  return `// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.\n${localized}`;
}

function applyWorkbenchAdapter(contents, file) {
  if (file === "components/ui/select.tsx") {
    return contents.replace(
      '        "z-50 min-w-[12rem] overflow-hidden rounded-[1.25rem]",',
      '        "lightvela-agent-console-portal z-50 min-w-[12rem] overflow-hidden rounded-[1.25rem]",',
    );
  }
  if (file === "components/ui/dialog.tsx") {
    return contents.replace(
      '        "fixed inset-x-4 bottom-4 z-50 rounded-[1.75rem] p-5 md:inset-auto md:left-1/2 md:top-1/2 md:w-[34rem] md:-translate-x-1/2 md:-translate-y-1/2",',
      '        "lightvela-agent-console-portal fixed inset-x-4 bottom-4 z-50 rounded-[1.75rem] p-5 md:inset-auto md:left-1/2 md:top-1/2 md:w-[34rem] md:-translate-x-1/2 md:-translate-y-1/2",',
    );
  }
  if (file === "components/ui/popover.tsx") {
    return contents.replace(
      'className={cn("z-50 rounded-lg outline-none", floatingPanelClass, className)}',
      'className={cn("lightvela-agent-console-portal z-50 rounded-lg outline-none", floatingPanelClass, className)}',
    );
  }
  if (file === "pages/marketing/agent-automations-panel.tsx") {
    const adapted = contents
      .replace(
        'className="fixed inset-x-0 top-4 z-[300] flex justify-center px-4"',
        'className="lightvela-agent-console-portal fixed inset-x-0 top-4 z-[300] flex justify-center px-4"',
      )
      .replace(
        'className={`pointer-events-auto fixed z-[260]',
        'className={`lightvela-agent-console-portal pointer-events-auto fixed z-[260]',
      )
      .replaceAll(
        'className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40',
        'className="lightvela-agent-console-portal lv-dialog-backdrop fixed inset-0 z-[200] flex items-center justify-center bg-black/40',
      )
      .replaceAll(
        'className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40',
        'className="lightvela-agent-console-portal lv-dialog-backdrop fixed inset-0 z-[210] flex items-center justify-center bg-black/40',
      )
      .replace(
        'className="relative min-w-0 w-full max-w-[800px] overflow-y-auto rounded-lg bg-white p-5 shadow-2xl"',
        'className="lv-dialog-surface relative min-w-0 w-full max-w-[800px] overflow-y-auto rounded-lg bg-white p-5 shadow-2xl"',
      )
      .replaceAll(
        'className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"',
        'className="lv-icon-button absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"',
      )
      .replace(
        'className="mt-1.5 inline-flex rounded-md bg-black/[0.04] p-1"',
        'className="lv-segmented-control mt-1.5 inline-flex rounded-md bg-black/[0.04] p-1"',
      )
      .replace(
        'className="inline-flex min-w-[88px] items-center justify-center gap-2 rounded-lg bg-black px-4 py-2 text-white transition hover:bg-black/85"',
        'className="lv-button lv-button--primary inline-flex min-w-[88px] items-center justify-center gap-2 rounded-lg bg-black px-4 py-2 text-white transition hover:bg-black/85"',
      )
      .replace(
        'className={`rounded-md px-3 py-1 text-sm font-medium transition ${kind === k ?',
        'className={`lv-segmented-control__item rounded-md px-3 py-1 text-sm font-medium transition ${kind === k ?',
      )
      .replace(
        'className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${effectiveWindowEnabled ?',
        'className={`lv-switch relative inline-flex h-5 w-9 items-center rounded-full transition ${effectiveWindowEnabled ?',
      )
      .replace(
        'className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition ${effectiveWindowEnabled ?',
        'className={`lv-switch__thumb inline-block h-4 w-4 rounded-full bg-white shadow-sm transition ${effectiveWindowEnabled ?',
      )
      .replace(
        'className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-700/30 accent-black"',
        'className="lv-checkbox mt-0.5 h-4 w-4 shrink-0 rounded border-amber-700/30 accent-black"',
      )
      .replace(
        'className="h-4 w-4 cursor-pointer rounded border-black/20 accent-black disabled:cursor-not-allowed"',
        'className="lv-checkbox h-4 w-4 cursor-pointer rounded border-black/20 accent-black disabled:cursor-not-allowed"',
      );
    const requiredControlClasses = [
      "lightvela-agent-console-portal",
      "lv-dialog-backdrop",
      "lv-dialog-surface",
      "lv-icon-button",
      "lv-button--primary",
      "lv-segmented-control",
      "lv-segmented-control__item",
      "lv-switch",
      "lv-switch__thumb",
      "lv-checkbox",
    ];
    for (const className of requiredControlClasses) {
      if (!adapted.includes(className)) {
        throw new Error(`mono2 automations adapter failed to install ${className}`);
      }
    }
    return adapted;
  }
  if (file === "pages/marketing/agent-diagnostics-panel.tsx") {
    const adapted = contents
      .replace(
        '"inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-black px-3.5 text-sm font-semibold text-white shadow-sm transition-colors",',
        '"lv-button lv-button--secondary inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-black px-3.5 text-sm font-semibold text-white shadow-sm transition-colors",',
      )
      .replace(
        '"inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-black px-3 text-sm font-semibold text-white shadow-sm transition-colors",',
        '"lv-button lv-button--secondary inline-flex h-7 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-black px-3 text-sm font-semibold text-white shadow-sm transition-colors",',
      );
    if ((adapted.match(/lv-button lv-button--secondary/g) ?? []).length !== 2) {
      throw new Error("mono2 diagnostics adapter failed to install semantic action buttons");
    }
    return adapted;
  }
  if (file === "pages/marketing/automation-skill-picker.tsx") {
    return contents.replace(
      'className="pointer-events-auto fixed z-[260]',
      'className="lightvela-agent-console-portal pointer-events-auto fixed z-[260]',
    );
  }
  if (file === "pages/marketing/agent-model-config/model-action-tooltip.tsx") {
    return contents.replace(
      'className={`pointer-events-auto fixed z-[260]',
      'className={`lightvela-agent-console-portal pointer-events-auto fixed z-[260]',
    );
  }
  if (file === "pages/marketing/agent-config/components/HermesQrCodeModal.tsx") {
    return contents.replace(
      'className="_lh-hermes-qr-modal__overlay"',
      'className="lightvela-agent-console-portal _lh-hermes-qr-modal__overlay"',
    );
  }
  if (file === "pages/marketing/agent-skills-panel.tsx") {
    return contents
      .replace(
        'import { ZhHantScope } from "./zh-hant-scope";',
        'import type { SkillsDataLayer } from "./skills-demo/skill-registries";\nimport { ZhHantScope } from "./zh-hant-scope";',
      )
      .replace(
        "  initialSectionSlug?: string;\n}",
        "  initialSectionSlug?: string;\n  skillsDataLayer: SkillsDataLayer;\n}",
      )
      .replace(
        "  initialSectionSlug,\n}: HermesAgentSkillsPanelProps)",
        "  initialSectionSlug,\n  skillsDataLayer,\n}: HermesAgentSkillsPanelProps)",
      )
      .replace(
        "          initialTab={initialGlobalSkillsTab}\n",
        "          initialTab={initialGlobalSkillsTab}\n          dataLayer={skillsDataLayer}\n",
      );
  }
  if (file === "pages/marketing/skills-demo/SkillsDemoPanel.tsx") {
    return contents
      .replace("  createSkillsDataLayer,\n", "")
      .replace(
        "  type Skill,\n  type SkillsExecDebugCommandStream,",
        "  type Skill,\n  type SkillsDataLayer,\n  type SkillsExecDebugCommandStream,",
      )
      .replace(
        "  initialTab = \"discover\",\n  onTabChange,\n}",
        "  initialTab = \"discover\",\n  onTabChange,\n  dataLayer,\n}",
      )
      .replace(
        "  onTabChange?: (value: SkillsDemoTab) => void;\n})",
        "  onTabChange?: (value: SkillsDemoTab) => void;\n  dataLayer: SkillsDataLayer;\n})",
      )
      .replace(
        /  const dataLayer = useMemo\(\n    \(\) => createSkillsDataLayer\([^\n]+\),\n    \[[^\n]+\],\n  \);\n\n/u,
        "",
      );
  }
  if (file === "i18n/index.ts") {
    // OpenCraft consumes this module in Vite and Metro renderers, never in
    // mono2's concurrent multi-locale SSR process. The eager dictionaries
    // already cover both product defaults; locale switches retain the shared
    // lazy loader below. Removing only the SSR preload keeps Metro free of
    // unsupported top-level await without changing the public i18n API.
    return contents.replace(
      /\/\*\n \* 服务端会按多条 locale 路由并发渲染，[\s\S]*?\n\}\n\n\/\*\*/u,
      "/**",
    );
  }
  if (file === "repositories/http-repositories.ts") {
    return contents.replace(
      'const AUTH_TOKEN_STORAGE_KEY = "lightclaw-auth-token-v1";',
      'const AUTH_TOKEN_STORAGE_KEY = "vela.lightvela.session-token.v1";',
    );
  }
  if (file === "lib/region.ts") {
    return contents.replace(
      'export const REGION: Region = envRegion ?? "cn";',
      'export const REGION: Region = envRegion ?? (globalThis.localStorage?.getItem("vela.lightvela.region.v1") === "intl" ? "global" : "cn");',
    );
  }
  if (file === "lib/auth-api-base.ts") {
    return contents.replace(
      "  if (typeof window !== \"undefined\") {\n    const hostname = window.location.hostname;",
      "  if (typeof window !== \"undefined\") {\n    const selectedRegion = globalThis.localStorage?.getItem(\"vela.lightvela.region.v1\");\n    if (selectedRegion === \"cn\") return \"https://api.lightvela.com\";\n    if (selectedRegion === \"intl\") return \"https://api.lightvela.ai\";\n    const hostname = window.location.hostname;",
    );
  }
  if (file === "contexts/repository-context.tsx") {
    return contents
      .replace(
        "export const RepositoryProvider = ({ children }: PropsWithChildren) => {\n  return <RepositoryContext value={repositories}>{children}</RepositoryContext>;\n};",
        "export const RepositoryProvider = ({ children, value = repositories }: PropsWithChildren<{ value?: Repositories }>) => {\n  return <RepositoryContext value={value}>{children}</RepositoryContext>;\n};",
      )
      .replace(
        "export const useRepositories = () => useContext(RepositoryContext);",
        "export const useRepositories = () => useContext(RepositoryContext);\nexport type { Repositories };",
      );
  }
  if (file === "observability/datong.ts") {
    return contents.replace(
      'import UniversalReport from "@tencent/universal-report";',
      'import UniversalReport from "../../universal-report-adapter";',
    );
  }
  return contents;
}

const files = collectSourceClosure();
if (!checkOnly) {
  rmSync(targetRoot, { force: true, recursive: true });
  mkdirSync(targetRoot, { recursive: true });
}

const manifest = [];
for (const file of files) {
  const source = join(sourceRoot, file);
  const target = join(targetRoot, file);
  mkdirSync(dirname(target), { recursive: true });
  const original = readFileSync(source);
  const contents = [".ts", ".tsx"].includes(extname(file))
    ? Buffer.from(applyWorkbenchAdapter(localizeAliases(original.toString("utf8"), file), file))
    : original;
  if (checkOnly) {
    if (!existsSync(target) || !readFileSync(target).equals(contents)) {
      throw new Error(`vendored mono2 file drifted; run npm run sync:mono2-agent-console: ${file}`);
    }
  } else {
    writeFileSync(target, contents);
  }
  manifest.push({
    file,
    sourceSha256: createHash("sha256").update(original).digest("hex"),
  });
}

for (const file of publicAssets) {
  const source = join(sourceFrontendRoot, "public", file);
  const target = join(targetPublicRoot, file);
  if (checkOnly) {
    if (!existsSync(target) || !readFileSync(target).equals(readFileSync(source))) {
      throw new Error(`vendored mono2 public asset drifted; run npm run sync:mono2-agent-console: ${file}`);
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

const sourceRevision = execFileSync("git", ["-C", sourceRepositoryRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

const manifestContents = `${JSON.stringify({
    source: sourceRoot,
    sourceRevision,
    generatedBy: "scripts/sync-mono2-agent-console.mjs",
    files: manifest,
    publicAssets,
  }, null, 2)}\n`;

if (checkOnly) {
  const manifestPath = join(targetRoot, "UPSTREAM.json");
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifestContents) {
    throw new Error("vendored mono2 manifest drifted; run npm run sync:mono2-agent-console");
  }
  const actualFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else actualFiles.push(relative(targetRoot, absolute));
    }
  };
  visit(targetRoot);
  const expectedFiles = new Set([...files, "UPSTREAM.json"]);
  const unexpected = actualFiles.filter((file) => !expectedFiles.has(file));
  if (unexpected.length > 0) throw new Error(`unexpected vendored mono2 files: ${unexpected.join(", ")}`);
} else {
  writeFileSync(join(targetRoot, "UPSTREAM.json"), manifestContents);
}

console.log(`${checkOnly ? "Verified" : "Synchronized"} ${files.length} mono2 Agent Console files in ${targetRoot}`);
