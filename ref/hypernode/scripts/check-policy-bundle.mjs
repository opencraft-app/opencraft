import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const [bundle, manifestText] = await Promise.all([
  readFile("policy/default.js", "utf8"),
  readFile("protocol/generated/app-server-manifest.json", "utf8"),
]);
const manifest = JSON.parse(manifestText);
async function policySourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await policySourceFiles(path));
    else if (
      entry.isFile() &&
      (entry.name.endsWith(".js") ||
        (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")))
    ) paths.push(path);
  }
  return paths;
}

const sourceFiles = await policySourceFiles("policy/src");
const sources = (await Promise.all(sourceFiles.map((path) => readFile(path, "utf8")))).join("\n");
const implemented = new Set([...sources.matchAll(/register\(\s*["']([^"']+)["']/g)].map((match) => match[1]));
const passthrough = sources.match(/const USER_BACKEND_CONTROL_METHODS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
for (const match of passthrough.matchAll(/["']([^"']+)["']/g)) implemented.add(match[1]);
const official = new Set(manifest.clientRequests.map(({ method }) => method));
const implementedOfficial = [...implemented].filter((method) => official.has(method)).sort();
const extensions = [...implemented].filter((method) => !official.has(method)).sort();

if (!bundle.includes("cordis")) throw new Error("policy bundle does not contain Cordis runtime");
if (!bundle.includes("globalThis.policy")) throw new Error("policy bundle does not expose globalThis.policy");
if (!implemented.has("account/read") || !implemented.has("config/read") || !implemented.has("model/list")) {
  throw new Error("new-chat preflight services are incomplete");
}

console.log(JSON.stringify({
  schemaSha256: manifest.sha256,
  officialRequestCount: official.size,
  implementedOfficialCount: implementedOfficial.length,
  implementedOfficial,
  protocolExtensions: extensions,
}, null, 2));
