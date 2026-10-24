import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const outputDirectory = resolve(repositoryRoot, "packages/appserver-protocol/src/generated");
const codexBinary = process.env.OPENCRAFT_CODEX_BINARY || "codex";

const version = execFileSync(codexBinary, ["--version"], { encoding: "utf8" }).trim();
if (!/^codex-cli\s+\S+$/.test(version)) {
  throw new Error(`Unexpected Codex version output: ${JSON.stringify(version)}`);
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
execFileSync(codexBinary, [
  "app-server",
  "generate-ts",
  "--experimental",
  "--out",
  outputDirectory,
], { stdio: "inherit" });

writeFileSync(resolve(outputDirectory, "SOURCE.json"), `${JSON.stringify({
  generator: version,
  command: "codex app-server generate-ts --experimental",
}, null, 2)}\n`, "utf8");

console.log(`Generated Codex AppServer protocol from ${version} in ${outputDirectory}`);
