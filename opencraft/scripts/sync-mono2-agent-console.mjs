import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceFrontendRoot = process.env.MONO2_FRONTEND_ROOT
  ? resolve(process.env.MONO2_FRONTEND_ROOT)
  : resolve(repositoryRoot, "../frontend");
const sourceRoot = join(sourceFrontendRoot, "src");
const sourceRepositoryRoot = resolve(sourceFrontendRoot, "..");
const sourceDescriptor = process.env.MONO2_FRONTEND_ROOT
  ? "$MONO2_FRONTEND_ROOT/src"
  : "frontend/src";
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
  // A source change must fail visibly instead of silently producing an unthemed portal.
  const replace = (anchor, replacement, expected = 1) => {
    const count = typeof anchor === "string"
      ? contents.split(anchor).length - 1
      : [...contents.matchAll(new RegExp(anchor.source, `${anchor.flags.replaceAll("g", "")}g`))].length;
    if (count !== expected) {
      throw new Error(`mono2 adapter anchor mismatch in ${file}: expected ${expected}, found ${count}: ${anchor}`);
    }
    contents = typeof anchor === "string" ? contents.replaceAll(anchor, replacement) : contents.replace(anchor, replacement);
  };
  if (file === "components/ui/button.tsx") {
    replace('className={cn(buttonVariants({ variant: resolvedVariant, size, className }))}',
      'className={cn("lv-button", `lv-button--${resolvedVariant === "default" ? "primary" : resolvedVariant}`, buttonVariants({ variant: resolvedVariant, size, className }))}');
    replace('default: { color: "white" }', 'default: { color: "var(--color-text-button-primary)" }');
    replace('secondary: { color: "var(--text-primary)" }', 'secondary: { color: "var(--color-text-button-secondary)" }');
    replace('hero: { color: "white" }', 'hero: { color: "var(--color-text-on-accent)" }');
    replace('ghost: { color: "var(--text-secondary)" }', 'ghost: { color: "var(--color-text-button-tertiary)" }');
    replace('destructive: { color: "white" }', 'destructive: { color: "var(--color-text-on-accent)" }');
    return contents;
  }
  if (file === "components/ui/select.tsx") {
    replace('      controlFieldClass,', '      "lv-select-trigger",\n      controlFieldClass,');
    replace('        "z-50 min-w-[12rem] overflow-hidden rounded-[1.25rem]",',
      '        "lightvela-agent-console-portal lv-floating-control lv-select-content z-50 min-w-[12rem] overflow-hidden rounded-[1.25rem]",');
    replace('<SelectPrimitive.Viewport className="p-1.5">', '<SelectPrimitive.Viewport className="lv-select-viewport p-1.5">');
    replace('"my-1 h-px bg-black/[0.08]"', '"lv-select-separator my-1 h-px bg-black/[0.08]"');
    replace('"relative flex w-full cursor-default select-none', '"lv-select-item relative flex w-full cursor-default select-none');
    replace('className="absolute left-2 flex size-4', 'className="lv-select-item__indicator absolute left-2 flex size-4');
    return contents;
  }
  if (file === "components/ui/dialog.tsx") {
    replace('className={cn(overlayBackdropClass, className)}',
      'className={cn("lightvela-agent-console-portal lv-dialog-backdrop", overlayBackdropClass, className)}');
    replace('        "fixed inset-x-4 bottom-4 z-50',
      '        "lightvela-agent-console-portal lv-dialog-surface fixed inset-x-4 bottom-4 z-50');
    replace('className="absolute right-3 top-3 rounded-lg', 'className="lv-icon-button absolute right-3 top-3 rounded-lg');
    return contents;
  }
  if (file === "components/ui/alert-dialog.tsx") {
    replace('cn("fixed inset-0 z-50 bg-black/40",',
      'cn("lightvela-agent-console-portal lv-dialog-backdrop lv-dialog-backdrop--confirmation fixed inset-0 z-50 bg-black/40",');
    replace('cn("fixed left-1/2 top-1/2 z-50',
      'cn("lightvela-agent-console-portal lv-dialog-surface lv-dialog-surface--confirmation fixed left-1/2 top-1/2 z-50');
    return contents;
  }
  if (file === "components/ui/popover.tsx") {
    replace('cn("z-50 rounded-lg outline-none",',
      'cn("lightvela-agent-console-portal lv-floating-control lv-popover-content z-50 rounded-lg outline-none",');
    return contents;
  }
  if (file === "components/ui/dropdown-menu.tsx") {
    replace('cn("z-50 max-h-[var(--radix-dropdown-menu-content-available-height)]',
      'cn("lightvela-agent-console-portal lv-floating-control lv-dropdown-content z-50 max-h-[var(--radix-dropdown-menu-content-available-height)]');
    replace('cn("flex min-h-9 cursor-default', 'cn("lv-dropdown-item flex min-h-9 cursor-default');
    replace('cn("relative flex min-h-9 cursor-default', 'cn("lv-dropdown-item relative flex min-h-9 cursor-default');
    return contents;
  }
  if (file === "components/ui/tooltip.tsx") {
    replace('cn("pointer-events-auto z-50', 'cn("lightvela-agent-console-portal lv-floating-control lv-tooltip-content pointer-events-auto z-50');
    replace('<TooltipPrimitive.Arrow className="fill-white" />', '<TooltipPrimitive.Arrow className="lv-tooltip-arrow" />');
    return contents;
  }
  if (file === "components/ui/checkbox.tsx") {
    replace('cn("peer inline-flex size-5', 'cn("lv-checkbox peer inline-flex size-5');
    return contents;
  }
  if (file === "components/ui/switch.tsx") {
    replace('cn("peer inline-flex h-6 w-11', 'cn("lv-switch peer inline-flex h-6 w-11');
    replace('className="pointer-events-none block size-5', 'className="lv-switch__thumb pointer-events-none block size-5');
    return contents;
  }
  if (file === "components/ui/tabs.tsx") {
    replace('      segmentedListClass,', '      "lv-segmented-control",\n      segmentedListClass,');
    replace('      segmentedTriggerClass,', '      "lv-segmented-control__item",\n      segmentedTriggerClass,');
    return contents;
  }
  if (file === "pages/marketing/agent-automations-panel.tsx") {
    replace('  border: "1px solid rgba(0,0,0,0.06)",\n  background: "#ffffff",\n  boxShadow: "none",',
      '  border: "1px solid var(--border-subtle)",\n  background: "var(--surface-raised)",\n  boxShadow: "none",');
    // Toast remains the only hand-owned portal here. Dialogs, tabs, switches,
    // checkboxes and pickers now inherit their guarded primitive adapters.
    replace('className="fixed inset-x-0 top-4 z-[300] flex justify-center px-4"',
      'className="lightvela-agent-console-portal fixed inset-x-0 top-4 z-[300] flex justify-center px-4"');
    return contents;
  }
  if (file === "pages/marketing/agent-skills-panel.tsx") {
      replace(
        'import { ZhHantScope } from "./zh-hant-scope";',
        'import type { SkillsDataLayer } from "./skills-demo/skill-registries";\nimport { ZhHantScope } from "./zh-hant-scope";',
      );
      replace(
        "  initialSectionSlug?: string;\n}",
        "  initialSectionSlug?: string;\n  skillsDataLayer: SkillsDataLayer;\n}",
      );
      replace(
        "  initialSectionSlug,\n}: HermesAgentSkillsPanelProps)",
        "  initialSectionSlug,\n  skillsDataLayer,\n}: HermesAgentSkillsPanelProps)",
      );
      replace(
        "          initialTab={initialGlobalSkillsTab}\n",
        "          initialTab={initialGlobalSkillsTab}\n          dataLayer={skillsDataLayer}\n",
      );
    return contents;
  }
  if (file === "pages/marketing/skills-demo/SkillsDemoPanel.tsx") {
      replace("  createSkillsDataLayer,\n", "");
      replace(
        "  type Skill,\n  type SkillsExecDebugCommandStream,",
        "  type Skill,\n  type SkillsDataLayer,\n  type SkillsExecDebugCommandStream,",
      );
      replace(
        "  initialTab = \"discover\",\n  onTabChange,\n}",
        "  initialTab = \"discover\",\n  onTabChange,\n  dataLayer,\n}",
      );
      replace(
        "  onTabChange?: (value: SkillsDemoTab) => void;\n})",
        "  onTabChange?: (value: SkillsDemoTab) => void;\n  dataLayer: SkillsDataLayer;\n})",
      );
      replace(
        /  const dataLayer = useMemo\(\n    \(\) => createSkillsDataLayer\([^\n]+\),\n    \[[^\n]+\],\n  \);\n\n/u,
        "",
      );
    return contents;
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
    replace(
      'const AUTH_TOKEN_STORAGE_KEY = "lightclaw-auth-token-v1";',
      'const AUTH_TOKEN_STORAGE_KEY = "vela.lightvela.session-token.v1";',
    );
    return contents;
  }
  if (file === "lib/region.ts") {
    replace(
      'export const REGION: Region = envRegion ?? "cn";',
      'export const REGION: Region = envRegion ?? (globalThis.localStorage?.getItem("vela.lightvela.region.v1") === "intl" ? "global" : "cn");',
    );
    return contents;
  }
  if (file === "lib/auth-api-base.ts") {
    replace(
      "  if (typeof window !== \"undefined\") {\n    const hostname = window.location.hostname;\n    if (hostname === \"localhost\" || hostname === \"127.0.0.1\") {",
      "  if (typeof window !== \"undefined\") {\n    const selectedRegion = globalThis.localStorage?.getItem(\"vela.lightvela.region.v1\");\n    if (selectedRegion === \"cn\") return \"https://api.lightvela.com\";\n    if (selectedRegion === \"intl\") return \"https://api.lightvela.ai\";\n    const hostname = window.location.hostname;\n    if (hostname === \"localhost\" || hostname === \"127.0.0.1\") {",
    );
    return contents;
  }
  if (file === "contexts/repository-context.tsx") {
      replace(
        "export const RepositoryProvider = ({ children }: PropsWithChildren) => {\n  return <RepositoryContext value={repositories}>{children}</RepositoryContext>;\n};",
        "export const RepositoryProvider = ({ children, value = repositories }: PropsWithChildren<{ value?: Repositories }>) => {\n  return <RepositoryContext value={value}>{children}</RepositoryContext>;\n};",
      );
      replace(
        "export const useRepositories = () => useContext(RepositoryContext);",
        "export const useRepositories = () => useContext(RepositoryContext);\nexport type { Repositories };",
      );
    return contents;
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

const manifestPath = join(targetRoot, "UPSTREAM.json");
let sourceRevision;
try {
  sourceRevision = execFileSync(
    "git",
    [
      "-C",
      sourceRepositoryRoot,
      "log",
      "-1",
      "--format=%H",
      "--",
      "frontend/src",
      "frontend/public/tat-hermes-web-proxy-sw.js",
      "frontend/public/assets/skills",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
} catch (error) {
  if (!checkOnly || !existsSync(manifestPath)) throw error;
  const recordedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  sourceRevision = typeof recordedManifest.sourceRevision === "string"
    ? recordedManifest.sourceRevision.trim()
    : "";
}

if (!sourceRevision) {
  throw new Error("unable to resolve the last mono2 frontend source revision");
}

const manifestContents = `${JSON.stringify({
    source: sourceDescriptor,
    sourceRevision,
    generatedBy: "scripts/sync-mono2-agent-console.mjs",
    files: manifest,
    publicAssets,
  }, null, 2)}\n`;

if (checkOnly) {
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
