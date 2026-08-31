import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(frontendRoot, process.env.TYPECHECK_CONFIG_PATH ?? "tsconfig.app.json");
const baselinePath = resolve(frontendRoot, "typecheck-baseline.json");
const fumadocsServerPath = resolve(frontendRoot, ".source/server.ts");
const fumadocsSourceRetryDelayMs = 5_000;
const updateBaseline = process.argv.includes("--update");

function normalizePath(fileName) {
  return relative(frontendRoot, fileName)
    .split(sep)
    .join("/")
    .replace(/^node_modules\/\.pnpm\/[^/]+\/node_modules\//, "node_modules/");
}

function normalizeDiagnostic(diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").replace(/\s+/g, " ").trim();
  const location = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    : null;
  return {
    file: diagnostic.file ? normalizePath(diagnostic.file.fileName) : "<global>",
    line: location ? location.line + 1 : 0,
    column: location ? location.character + 1 : 0,
    code: diagnostic.code,
    message,
    fingerprint: createHash("sha256").update(message).digest("hex").slice(0, 16),
  };
}

function diagnosticKey(diagnostic) {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}|TS${diagnostic.code}|${diagnostic.fingerprint}`;
}

function countDiagnostics(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    const current = counts.get(key);
    counts.set(key, current ? { ...current, count: current.count + 1 } : { ...diagnostic, count: 1 });
  }
  return counts;
}

function loadBaseline() {
  const value = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (value.version !== 1 || !value.diagnostics || typeof value.diagnostics !== "object" || Array.isArray(value.diagnostics)) {
    throw new Error("typecheck-baseline.json has an unsupported format");
  }
  const entries = Object.entries(value.diagnostics);
  if (entries.some(([, count]) => !Number.isInteger(count) || count < 1)) {
    throw new Error("typecheck-baseline.json contains an invalid diagnostic count");
  }
  return new Map(entries);
}

function collectCurrentDiagnostics() {
  const program = ts.createProgram({ rootNames: parsedConfig.fileNames, options: parsedConfig.options });
  return countDiagnostics(ts.getPreEmitDiagnostics(program).map(normalizeDiagnostic));
}

function getDiagnosticDelta(currentDiagnostics, baselineDiagnostics) {
  const newDiagnostics = [];
  let resolvedCount = 0;

  for (const [key, diagnostic] of currentDiagnostics) {
    const baselineCount = baselineDiagnostics.get(key) ?? 0;
    if (diagnostic.count > baselineCount) {
      newDiagnostics.push({ ...diagnostic, count: diagnostic.count - baselineCount });
    }
  }
  for (const [key, diagnosticCount] of baselineDiagnostics) {
    const currentCount = currentDiagnostics.get(key)?.count ?? 0;
    resolvedCount += Math.max(0, diagnosticCount - currentCount);
  }

  return { newDiagnostics, resolvedCount };
}

function isFumadocsSourceResolutionRace(diagnostic) {
  return diagnostic.file === "next-site/source.ts"
    && diagnostic.code === 2305
    && diagnostic.message.includes("Module '\"collections/server\"' has no exported member 'docs'.");
}

function hasGeneratedDocsExport() {
  try {
    return readFileSync(fumadocsServerPath, "utf8").includes("export const docs");
  } catch {
    return false;
  }
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(ts.formatDiagnostic(configFile.error, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => frontendRoot,
    getNewLine: () => "\n",
  }));
  process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, frontendRoot, undefined, configPath);
if (parsedConfig.errors.length > 0) {
  console.error(ts.formatDiagnostics(parsedConfig.errors, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => frontendRoot,
    getNewLine: () => "\n",
  }));
  process.exit(1);
}
if (parsedConfig.fileNames.length === 0) {
  console.error(`TypeScript config ${normalizePath(configPath)} resolved to zero source files.`);
  process.exit(1);
}
let currentDiagnostics = collectCurrentDiagnostics();

if (updateBaseline) {
  const diagnostics = Object.fromEntries([...currentDiagnostics.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, diagnostic]) => [key, diagnostic.count]));
  writeFileSync(baselinePath, `${JSON.stringify({ version: 1, diagnostics }, null, 2)}\n`);
  console.log(`Updated TypeScript baseline with ${[...currentDiagnostics.values()].reduce((total, item) => total + item.count, 0)} diagnostics.`);
  process.exit(0);
}

const baselineDiagnostics = loadBaseline();
let { newDiagnostics, resolvedCount } = getDiagnosticDelta(currentDiagnostics, baselineDiagnostics);

if (newDiagnostics.some(isFumadocsSourceResolutionRace) && hasGeneratedDocsExport()) {
  console.warn(`Detected fumadocs source resolution race; retrying typecheck in ${fumadocsSourceRetryDelayMs}ms.`);
  await wait(fumadocsSourceRetryDelayMs);
  currentDiagnostics = collectCurrentDiagnostics();
  ({ newDiagnostics, resolvedCount } = getDiagnosticDelta(currentDiagnostics, baselineDiagnostics));
}

const currentCount = [...currentDiagnostics.values()].reduce((total, item) => total + item.count, 0);
const baselineCount = [...baselineDiagnostics.values()].reduce((total, count) => total + count, 0);
const newCount = newDiagnostics.reduce((total, item) => total + item.count, 0);
console.log(`TypeScript diagnostics: ${currentCount} current, ${baselineCount} baseline, ${newCount} new, ${resolvedCount} resolved.`);

if (newDiagnostics.length > 0) {
  for (const diagnostic of newDiagnostics.slice(0, 50)) {
    const suffix = diagnostic.count > 1 ? ` (x${diagnostic.count})` : "";
    console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: TS${diagnostic.code}: ${diagnostic.message}${suffix}`);
  }
  if (newDiagnostics.length > 50) {
    console.error(`...and ${newDiagnostics.length - 50} more diagnostic groups.`);
  }
  process.exit(1);
}
