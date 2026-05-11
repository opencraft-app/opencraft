import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = process.argv[2] ? resolve(process.argv[2]) : resolve(scriptDir, "..");
const publicDir = join(frontendRoot, "public");
const routerFile = join(frontendRoot, "src", "router", "index.tsx");

const ignoredRouteSegments = new Set(["", "*"]);

const firstSegment = (path) => path.replace(/^\/+/, "").split("/")[0] ?? "";

const publicTopLevelDirs = new Set(
  readdirSync(publicDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);

const routerSource = readFileSync(routerFile, "utf8");
const routeSegments = new Set();
for (const match of routerSource.matchAll(/\bpath:\s*["']([^"']+)["']/g)) {
  const segment = firstSegment(match[1]);
  if (!ignoredRouteSegments.has(segment)) {
    routeSegments.add(segment);
  }
}

const conflicts = [...publicTopLevelDirs]
  .filter((directory) => routeSegments.has(directory))
  .sort();

if (conflicts.length > 0) {
  console.error("frontend static route conflict detected:");
  for (const directory of conflicts) {
    console.error(`- public/${directory}/ conflicts with BrowserRouter route /${directory}`);
  }
  console.error("Move route-owned static assets under public/assets/<name>/ or rename the route/static directory.");
  process.exit(1);
}

console.log("frontend static route conflict check passed");
