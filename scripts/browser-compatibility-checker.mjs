import { ESLint } from "eslint";
import path from "node:path";
import ts from "typescript";
import browserConfig from "../config/eslint.browser.config.mjs";
import { isBareModuleSpecifier, isExternalWorkspaceSource } from "./workspace-dependencies.mjs";

/** Only the last real bundle's local runtime modules are linted. No downstream
 * directory is scanned, and a missing or invalid graph fails rather than skips. */
export async function checkBrowserCompatibility(root, files) {
  if (!Array.isArray(files) || files.length === 0 || !files.every(file =>
    typeof file === "string" && file.length > 0 && !/[\\\0?#]/u.test(file)
    && !file.split("/").includes("node_modules")
    && /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file)
    && path.relative(root, path.resolve(root, file)).split(path.sep).join("/") === file)) {
    throw new Error("Invalid browser module graph. Run npm run build:web first.");
  }
  const resolved = files.map(file => path.resolve(root, file));
  let cwd = path.resolve(root);
  while (resolved.some(file => {
    const relative = path.relative(cwd, file);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  })) {
    const parent = path.dirname(cwd);
    if (parent === cwd) throw new Error("Browser runtime sources must share a filesystem root for compatibility analysis.");
    cwd = parent;
  }
  // Preserve one ESNext/DOM type universe even for external products with a
  // narrower tsconfig. Their runtime source must not lose typed API rejection.
  const configFile = path.join(root, "config/tsconfig.browser-compatibility.json");
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile), {}, configFile);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  const host = ts.createCompilerHost(parsed.options);
  const moduleCache = ts.createModuleResolutionCache(root,
    file => ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(), parsed.options);
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    const normal = ts.resolveModuleName(name, containingFile, parsed.options, host, moduleCache).resolvedModule;
    if (normal || !isBareModuleSpecifier(name) || !isExternalWorkspaceSource(root, containingFile)) return normal;
    return ts.resolveModuleName(name, path.join(root, "__opencraft_dependency_context__.ts"),
      parsed.options, host, moduleCache).resolvedModule;
  });
  const program = ts.createProgram({
    rootNames: [...new Set([...parsed.fileNames, ...resolved.filter(file => /\.[cm]?tsx?$/u.test(file))])],
    options: parsed.options, host,
  });
  const missingTypes = resolved.flatMap(file => {
    const source = program.getSourceFile(file);
    return source ? program.getSemanticDiagnostics(source).filter(diagnostic => diagnostic.code === 2307) : [];
  });
  if (missingTypes.length) throw new Error("Browser module type resolution failed:\n" + missingTypes.map(diagnostic =>
    `${diagnostic.file?.fileName}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`).join("\n"));
  const eslint = new ESLint({ cwd, allowInlineConfig: false, ignore: false,
    overrideConfigFile: true,
    overrideConfig: [...browserConfig, { files: ["**/*.{ts,mts,cts,tsx}"],
      languageOptions: { parserOptions: { project: null, programs: [program] } },
    }],
  });
  const results = await eslint.lintFiles(resolved);
  const formatter = await eslint.loadFormatter("stylish");
  return { results, output: formatter.format(results) };
}
