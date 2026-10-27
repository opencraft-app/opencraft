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

function createWrapPreference() {
  const observers = new Set<() => void>();
  let current = false;
  const update = (value: boolean): void => {
    if (value === current) return;
    current = value;
    for (const observer of observers) observer();
  };
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void): () => boolean {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    set: update,
    toggle: () => update(!current),
  };
}

/** One observable preference shared by code surfaces on each client. */
export const codeBlockWrapPreference = createWrapPreference();

const svgLanguages = new Set(["svg", "html", "xml"]);

/** Presentation recognition only; the renderer owns preview safety. */
export function isSvgCodeSnippet(code: string, language: string | null): boolean {
  if (!svgLanguages.has(language?.trim().toLowerCase() ?? "")) return false;
  const opening = code.trimStart();
  if (opening.slice(0, 4).toLowerCase() !== "<svg") return false;
  const delimiter = opening.charAt(4);
  return delimiter === ">" || (delimiter !== "" && delimiter.trim() === "");
}

export function resolveCodeSurfacePolicy(options: ResolveCodeSurfacePolicyOptions): CodeSurfacePolicy {
  const variant = options.variant ?? "default";
  const fixedWidth = variant === "preview" || isSvgCodeSnippet(options.code, options.language);
  const wrap: CodeBlockWrapPolicy = fixedWidth ? "off" : options.forceWrap ? "always" : "user-controlled";
  return { variant, wrap };
}

const languageNames = new Map<string, string>();
for (const [label, aliases] of [
  ["TypeScript", ["ts", "tsx", "typescript"]],
  ["JavaScript", ["js", "jsx", "javascript"]],
  ["Python", ["py", "python"]],
  ["Python REPL", ["python-repl"]],
  ["Bash", ["sh", "bash", "zsh"]],
  ["Shell", ["shell"]],
  ["JSON", ["json"]],
  ["YAML", ["yaml", "yml"]],
  ["Markdown", ["md", "markdown"]],
  ["XML", ["html", "xml"]],
  ["Rust", ["rs", "rust"]],
  ["Plain text", ["text", "plaintext"]],
  ["C", ["c"]], ["C++", ["cpp", "c++"]], ["C#", ["cs", "csharp", "c#"]],
  ["Go", ["go"]], ["Java", ["java"]], ["Kotlin", ["kotlin"]],
  ["Arduino", ["arduino"]], ["PHP template", ["php-template"]],
  ["Swift", ["swift"]], ["Ruby", ["rb", "ruby"]], ["PHP", ["php"]],
  ["SQL", ["sql"]], ["CSS", ["css"]], ["SCSS", ["scss"]],
  ["Less", ["less"]], ["INI", ["ini"]],
  ["WebAssembly", ["wasm"]], ["R", ["r"]], ["Perl", ["perl"]], ["Lua", ["lua"]], ["Diff", ["diff", "patch"]],
  ["Makefile", ["makefile"]], ["GraphQL", ["graphql", "gql"]],
  ["Visual Basic .NET", ["vb", "vbnet"]], ["Objective-C", ["objc", "objectivec"]],
] as const) {
  for (const alias of aliases) languageNames.set(alias, label);
}

export function codeLanguageLabel(language: string | null, open: boolean): string {
  const key = language?.trim().toLowerCase() ?? "";
  if (key.length === 0) return open ? "" : "Code";
  return languageNames.get(key) ?? language!;
}
