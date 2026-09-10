import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

import { unwrapHighlightedCodeHtml } from "./highlighted-code-html";
import { codexDarkTheme, codexLightTheme } from "./codex-themes";

const languageAliases: Record<string, string> = {
  c: "cpp", cjs: "javascript", h: "cpp", hpp: "cpp", js: "javascript",
  jsonc: "json", md: "markdown", mjs: "javascript", py: "python",
  rs: "rust", sh: "bash", shell: "bash", shellscript: "bash",
  ts: "typescript", yml: "yaml",
};

const languageLoaders = {
  bash: () => import("@shikijs/langs/bash").then((module) => module.default),
  cpp: () => import("@shikijs/langs/cpp").then((module) => module.default),
  css: () => import("@shikijs/langs/css").then((module) => module.default),
  diff: () => import("@shikijs/langs/diff").then((module) => module.default),
  go: () => import("@shikijs/langs/go").then((module) => module.default),
  html: () => import("@shikijs/langs/html").then((module) => module.default),
  java: () => import("@shikijs/langs/java").then((module) => module.default),
  javascript: () => import("@shikijs/langs/javascript").then((module) => module.default),
  json: () => import("@shikijs/langs/json").then((module) => module.default),
  jsx: () => import("@shikijs/langs/jsx").then((module) => module.default),
  markdown: () => import("@shikijs/langs/markdown").then((module) => module.default),
  python: () => import("@shikijs/langs/python").then((module) => module.default),
  rust: () => import("@shikijs/langs/rust").then((module) => module.default),
  sql: () => import("@shikijs/langs/sql").then((module) => module.default),
  swift: () => import("@shikijs/langs/swift").then((module) => module.default),
  tsx: () => import("@shikijs/langs/tsx").then((module) => module.default),
  typescript: () => import("@shikijs/langs/typescript").then((module) => module.default),
  yaml: () => import("@shikijs/langs/yaml").then((module) => module.default),
} as const;

type SupportedLanguage = keyof typeof languageLoaders;
type HighlightLanguage = SupportedLanguage | "text";
export type CodeHighlightTheme = "light" | "dark";

const highlighterPromise = createHighlighterCore({
  engine: createJavaScriptRegexEngine(),
  langs: [],
  themes: [codexLightTheme, codexDarkTheme],
});
const languageLoads = new Map<SupportedLanguage, Promise<void>>();

function normalizeLanguage(language: string | null): HighlightLanguage {
  const normalized = (language ?? "text").trim().toLowerCase();
  const aliased = languageAliases[normalized] ?? normalized;
  return Object.hasOwn(languageLoaders, aliased)
    ? (aliased as SupportedLanguage)
    : "text";
}

async function ensureLanguage(language: HighlightLanguage, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (language === "text") return;
  const highlighter = await highlighterPromise;
  signal.throwIfAborted();
  if (highlighter.getLoadedLanguages().includes(language)) return;
  let pending = languageLoads.get(language);
  if (pending === undefined) {
    pending = languageLoaders[language]().then(async (registrations) => {
      await highlighter.loadLanguage(...registrations);
    }).catch((error: unknown) => {
      languageLoads.delete(language);
      throw error;
    });
    languageLoads.set(language, pending);
  }
  await pending;
  signal.throwIfAborted();
}

export async function highlightCode(
  code: string,
  languageName: string | null,
  theme: CodeHighlightTheme,
  signal: AbortSignal,
): Promise<string> {
  const language = normalizeLanguage(languageName);
  await ensureLanguage(language, signal);
  const highlighter = await highlighterPromise;
  signal.throwIfAborted();
  const html = unwrapHighlightedCodeHtml(highlighter.codeToHtml(code, {
    lang: language,
    theme: theme === "dark" ? "codex-dark" : "codex-light",
  }));
  signal.throwIfAborted();
  return html;
}
