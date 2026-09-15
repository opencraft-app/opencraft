import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const manifestPath = join(repositoryRoot, "protocol/generated/app-server-manifest.json");
const schemaPath = join(repositoryRoot, "protocol/upstream/codex_app_server_protocol.schemas.json");
const policyRoot = join(repositoryRoot, "policy/src");
const rendererRoot = resolve(
  process.env.HYPERNODE_RENDERER_SOURCE
    ?? "/data/mia/.runtime/partition-r312-compat-detached-src",
);
const databasePath = resolve(
  process.env.HYPERNODE_DATABASE ?? join(repositoryRoot, ".runtime/hypernode.sqlite"),
);
const outputRoot = resolve(
  process.env.HYPERNODE_CAPABILITY_REPORT_DIR
    ?? join(repositoryRoot, ".runtime/reports"),
);

async function filesUnder(root, accept, excludedDirectory = () => false) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectory(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && accept(path)) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

function stringSet(source, declaration) {
  const body = source.match(new RegExp(
    `const\\s+${declaration}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\);`,
  ))?.[1] ?? "";
  return new Set([...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]));
}

function sqliteJson(sql) {
  try {
    const output = execFileSync("sqlite3", ["-json", databasePath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

function schemaDefinition(schema, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  return ref.slice(2).split("/").reduce((value, segment) => value?.[segment], schema);
}

function parameterKeys(schema, request) {
  const definition = schemaDefinition(schema, request.paramsRef);
  return Object.keys(definition?.properties ?? {}).sort();
}

function rendererEvidence(method, sources) {
  const needle = `\`${method}\``;
  const alternateNeedles = [`"${method}"`, `'${method}'`];
  const files = [];
  let occurrences = 0;
  for (const source of sources) {
    let count = source.text.split(needle).length - 1;
    for (const alternate of alternateNeedles) count += source.text.split(alternate).length - 1;
    if (count === 0) continue;
    occurrences += count;
    if (files.length < 5) files.push(relative(rendererRoot, source.path));
  }
  return { occurrences, files };
}

function markdown(report) {
  const lines = [
    "# Codex Desktop SSH host capability report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `- Official client requests: ${report.summary.officialRequests}`,
    `- Total request/notification names in the joined evidence: ${report.summary.protocolNames}`,
    `- Referenced by recovered Renderer: ${report.summary.rendererReferenced}`,
    `- Observed on port 9988: ${report.summary.observed}`,
    `- HyperNode local handlers: ${report.summary.local}`,
    `- User-control backend routes: ${report.summary.controlBackend}`,
    `- Conditional transparent Thread routes: ${report.summary.transparentThread}`,
    `- Observed protocol gaps: ${report.summary.observedGaps}`,
    "",
    "The routing columns are intentionally independent. A method may be handled locally in one",
    "context and forwarded to a real Codex app-server in another. `transparent-thread` means the",
    "request is forwarded only when it names a HyperNode-managed transparent Thread.",
    "",
    "| Method | Renderer refs | Live requests | Route | Method-not-found | Evidence |",
    "| --- | ---: | ---: | --- | ---: | --- |",
  ];
  for (const row of report.methods) {
    const evidence = row.renderer.files.slice(0, 2).map((path) => `\`${path}\``).join("<br>");
    lines.push(
      `| \`${row.method}\` | ${row.renderer.occurrences} | ${row.live.requests} | ${row.routes.join(", ") || "unclassified"} | ${row.live.methodNotFound} | ${evidence} |`,
    );
  }
  lines.push(
    "",
    "## Highest-value observed gaps",
    "",
  );
  const gaps = report.methods
    .filter((row) => row.live.requests > 0 && row.routes.length === 0 && row.protocolKind !== "client-notification")
    .sort((left, right) => right.live.requests - left.live.requests)
    .slice(0, 20);
  if (gaps.length === 0) lines.push("No observed unclassified requests.");
  else for (const row of gaps) lines.push(`- \`${row.method}\`: ${row.live.requests} requests, ${row.renderer.occurrences} Renderer references`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const [manifest, schema, policyPaths, rendererPaths] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(schemaPath, "utf8").then(JSON.parse),
  filesUnder(policyRoot, (path) => path.endsWith(".js")),
  filesUnder(rendererRoot, (path) => path.endsWith(".ts"), (name) => name === "__mia-assets"),
]);
const policySources = await Promise.all(policyPaths.map((path) => readFile(path, "utf8")));
const policyText = policySources.join("\n");
const rendererSources = await Promise.all(rendererPaths.map(async (path) => ({
  path,
  text: await readFile(path, "utf8"),
})));

const localHandlers = new Set(
  [...policyText.matchAll(/register\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
);
const controlBackend = stringSet(policyText, "USER_BACKEND_CONTROL_METHODS");
const builtin = new Set(["initialize"]);
const requests = new Map(sqliteJson(`
  SELECT json_extract(payload, '$.method') AS method,
         COUNT(*) AS requests,
         COUNT(DISTINCT connection_id) AS connections,
         MAX(CASE WHEN instr(COALESCE(json_extract(payload, '$.paramKeys'), ''), '"threadId"') > 0
                  THEN 1 ELSE 0 END) AS hasThreadId
  FROM events
  WHERE type = 'rpc.request' AND json_extract(payload, '$.method') IS NOT NULL
  GROUP BY method
`).map((row) => [row.method, row]));
const methodNotFound = new Map(sqliteJson(`
  SELECT json_extract(payload, '$.method') AS method, COUNT(*) AS failures
  FROM events
  WHERE type = 'rpc.error' AND json_extract(payload, '$.code') = -32601
  GROUP BY method
`).map((row) => [row.method, row.failures]));
const clients = sqliteJson(`
  SELECT json_extract(payload, '$.client.name') AS name,
         json_extract(payload, '$.client.version') AS version,
         COUNT(*) AS requests
  FROM events
  WHERE type = 'rpc.request' AND json_extract(payload, '$.client.name') IS NOT NULL
  GROUP BY name, version
  ORDER BY requests DESC
`);

const officialKinds = new Map();
for (const [kind, entries] of [
  ["client-request", manifest.clientRequests],
  ["client-notification", manifest.clientNotifications],
]) {
  for (const entry of entries) officialKinds.set(entry.method, { kind, request: entry });
}
const protocolNames = new Set([
  ...officialKinds.keys(),
  ...requests.keys(),
  ...localHandlers,
  ...controlBackend,
]);
const methods = [...protocolNames].map((method) => {
  const official = officialKinds.get(method);
  const params = official ? parameterKeys(schema, official.request) : [];
  const renderer = rendererEvidence(method, rendererSources);
  const live = requests.get(method) ?? {};
  const routes = [];
  if (builtin.has(method)) routes.push("builtin");
  if (localHandlers.has(method)) routes.push("local");
  if (controlBackend.has(method)) routes.push("user-control-backend");
  if (params.includes("threadId") || Number(live.hasThreadId ?? 0) === 1) routes.push("transparent-thread");
  return {
    method,
    protocolKind: official?.kind ?? "extension-or-unknown",
    params,
    routes,
    renderer,
    live: {
      requests: Number(live.requests ?? 0),
      connections: Number(live.connections ?? 0),
      methodNotFound: Number(methodNotFound.get(method) ?? 0),
    },
  };
}).sort((left, right) => (
  right.live.requests - left.live.requests
  || right.renderer.occurrences - left.renderer.occurrences
  || left.method.localeCompare(right.method)
));

const report = {
  generatedAt: new Date().toISOString(),
  inputs: {
    schemaSha256: manifest.sha256,
    rendererRoot,
    rendererFiles: rendererPaths.length,
    databasePath,
  },
  clients,
  summary: {
    officialRequests: manifest.clientRequests.length,
    protocolNames: methods.length,
    rendererReferenced: methods.filter((row) => row.renderer.occurrences > 0).length,
    observed: methods.filter((row) => row.live.requests > 0).length,
    local: methods.filter((row) => row.routes.includes("local") || row.routes.includes("builtin")).length,
    controlBackend: methods.filter((row) => row.routes.includes("user-control-backend")).length,
    transparentThread: methods.filter((row) => row.routes.includes("transparent-thread")).length,
    observedGaps: methods.filter((row) => (
      row.live.requests > 0
      && row.routes.length === 0
      && row.protocolKind !== "client-notification"
    )).length,
  },
  methods,
};

await mkdir(outputRoot, { recursive: true });
const jsonPath = join(outputRoot, "desktop-host-capabilities.json");
const markdownPath = join(outputRoot, "desktop-host-capabilities.md");
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
  writeFile(markdownPath, markdown(report)),
]);
console.log(JSON.stringify({
  ...report.summary,
  rendererFiles: rendererPaths.length,
  report: relative(repositoryRoot, markdownPath),
  data: relative(repositoryRoot, jsonPath),
}, null, 2));
