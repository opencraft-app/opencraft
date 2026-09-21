let codeWrapEnabled = false;
const codeWrapListeners = new Set<() => void>();

export const codeBlockWrapPreference = {
  getSnapshot: () => codeWrapEnabled,
  subscribe(listener: () => void) {
    codeWrapListeners.add(listener);
    return () => codeWrapListeners.delete(listener);
  },
  set(value: boolean) {
    if (value === codeWrapEnabled) return;
    codeWrapEnabled = value;
    for (const listener of codeWrapListeners) listener();
  },
  toggle() {
    codeBlockWrapPreference.set(!codeWrapEnabled);
  },
};

export type CodeBlockWrapPolicy = "off" | "always" | "user-controlled";
export type CodeSurfaceVariant = "default" | "preview";

export interface CodeSurfacePolicy {
  readonly variant: CodeSurfaceVariant;
  readonly wrap: CodeBlockWrapPolicy;
}

export interface ResolveCodeSurfacePolicyOptions {
  readonly code: string;
  readonly forceWrap?: boolean;
  readonly language: string | null;
  readonly variant?: CodeSurfaceVariant;
}

export function isSvgCodeSnippet(code: string, language: string | null): boolean {
  const normalized = language?.trim().toLowerCase() ?? "";
  return (normalized === "svg" || normalized === "xml" || normalized === "html")
    && /^\s*<svg(?:\s|>)/iu.test(code);
}

/** Source-faithful policy boundary from Codex's CodeBlockRendererSwitch. */
export function resolveCodeSurfacePolicy({
  code,
  forceWrap = false,
  language,
  variant = "default",
}: ResolveCodeSurfacePolicyOptions): CodeSurfacePolicy {
  if (variant === "preview" || isSvgCodeSnippet(code, language)) {
    return { variant, wrap: "off" };
  }
  return {
    variant,
    wrap: forceWrap ? "always" : "user-controlled",
  };
}

const languageLabels: Readonly<Record<string, string>> = {
  arduino: "Arduino", bash: "Bash", c: "C", cpp: "C++", csharp: "C#", css: "CSS",
  diff: "Diff", go: "Go", graphql: "GraphQL", ini: "INI", java: "Java",
  javascript: "JavaScript", json: "JSON", kotlin: "Kotlin", less: "Less", lua: "Lua",
  makefile: "Makefile", markdown: "Markdown", objectivec: "Objective-C", perl: "Perl",
  php: "PHP", "php-template": "PHP template", plaintext: "Plain text", python: "Python",
  "python-repl": "Python REPL", r: "R", ruby: "Ruby", rust: "Rust", scss: "SCSS",
  shell: "Shell", sql: "SQL", swift: "Swift", typescript: "TypeScript", vbnet: "Visual Basic .NET",
  wasm: "WebAssembly", xml: "XML", yaml: "YAML",
};

const languageAliases: Readonly<Record<string, string>> = {
  "c#": "csharp", "c++": "cpp", cs: "csharp", gql: "graphql", html: "xml",
  js: "javascript", jsx: "javascript", md: "markdown", objc: "objectivec", patch: "diff",
  py: "python", rb: "ruby", rs: "rust", sh: "bash", text: "plaintext", ts: "typescript",
  tsx: "typescript", vb: "vbnet", yml: "yaml", zsh: "bash",
};

export function codeLanguageLabel(language: string | null, open: boolean): string {
  if (language === null || language.trim().length === 0) return open ? "" : "Code";
  const normalized = language.trim().toLowerCase();
  const canonical = languageAliases[normalized] ?? normalized;
  return languageLabels[canonical] ?? language;
}
