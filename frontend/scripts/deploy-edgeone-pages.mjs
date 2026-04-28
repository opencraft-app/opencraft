import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Project name on EdgeOne Pages. Defaults to what we created on 2026-04-27.
const projectName =
  process.env.EDGEONE_PAGES_PROJECT_NAME?.trim() || "lightvela-preview";

// "production" or "preview"
const env = process.env.EDGEONE_PAGES_ENV?.trim() || "production";

// "global" (海外，*.edgeone.cool) or "overseas". The currently-linked
// project (pages-fqdz1kdlfvp1) was created in "global".
const area = process.env.EDGEONE_PAGES_AREA?.trim() || "global";

const deployDir = process.env.EDGEONE_PAGES_DIR?.trim() || "./dist";

// Token resolution order:
//   1. EDGEONE_API_TOKEN env var (preferred in CI)
//   2. ~/.tencentcloud/edgeone_pages_token  (local dev; 0600)
//   3. fall back to `edgeone login` session
function resolveToken() {
  const fromEnv = process.env.EDGEONE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const path = join(homedir(), ".tencentcloud", "edgeone_pages_token");
    const raw = readFileSync(path, "utf8").trim();
    if (raw) return raw;
  } catch {
    // fall through to logged-in session
  }
  return null;
}

const token = resolveToken();

const args = [
  "edgeone",
  "pages",
  "deploy",
  deployDir,
  "--name",
  projectName,
  "--env",
  env,
  "--area",
  area,
];

if (token) {
  args.push("--token", token);
}

const result = spawnSync("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
