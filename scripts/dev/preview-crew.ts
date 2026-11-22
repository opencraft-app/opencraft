import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startHeadlessServer } from "../../apps/headless-server/src/headless-server.mjs";
import { headlessWebHostDefinitions } from "../packaging/package-headless-linux.mjs";

/**
 * Local preview of crew: the real Headless server, Core, Inbox, Server spaces and managed Bot Host,
 * with local sign-in and two accounts so one person can play the space owner and a member in two
 * browser windows. Data persists between runs in its own directory.
 *
 *   npm run preview:crew               Bots use the model you choose for them in the Workbench.
 *   npm run preview:crew -- --fixture  Bots answer with the deterministic fixture; no model needed.
 *   npm run preview:crew -- --reset    Start over with a fresh preview directory.
 *   npm run preview:crew -- --rebuild  Rebuild the headless Workbench after pulling new code.
 */
const root = process.cwd();
const fixture = process.argv.includes("--fixture");
const port = Number(process.env.OPENCRAFT_CREW_PREVIEW_PORT ?? 10010);
const origin = `http://127.0.0.1:${port}`;
const home = resolve(process.env.OPENCRAFT_CREW_PREVIEW_DATA ?? join(homedir(), ".opencraft", "crew-preview"));
const dataDirectory = join(home, "server"),
  privateDirectory = join(home, "private");
const accountsFile = join(privateDirectory, "accounts.json"),
  authFile = join(privateDirectory, "auth.json");
const webRoot = join(root, "apps/workbench-web/dist");

if (process.argv.includes("--reset")) await rm(home, { recursive: true, force: true });
for (const directory of [home, dataDirectory, privateDirectory]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}
// The pinned execution engine the Headless server expects; idempotent, as in npm run dev.
if (spawnSync("npm", ["run", "prepare:dsh-runtime"], { cwd: root, stdio: "inherit" }).status !== 0)
  throw Error("Engine preparation failed");
// The Headless server serves only a headless Web build; build one the same way deployment does.
const headlessBuild = async () => {
  try {
    return JSON.parse(await readFile(join(webRoot, "version.json"), "utf8"))?.headlessServer === true;
  } catch {
    return false;
  }
};
if (!(await headlessBuild()) || process.argv.includes("--rebuild")) {
  console.log("Building the headless Workbench for the preview…");
  const env = {
    ...process.env,
    OPENCRAFT_HEADLESS_SERVER_BUILD: "true",
    VITE_HYPERNODE_PLUGIN: "disabled",
    VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()),
  };
  if (spawnSync("npm", ["run", "build:web:release"], { cwd: root, stdio: "inherit", env }).status !== 0)
    throw Error("Workbench build failed");
}

// Local sign-in for this loopback origin only.
await writeFile(authFile, JSON.stringify({ origin, local: true, oidc: [] }), { mode: 0o600 });
await chmod(authFile, 0o600);

// Two local accounts on first run, through the same operator command as a real deployment.
type Accounts = Record<"alice" | "bob", string>;
let accounts: Accounts;
if (existsSync(accountsFile)) accounts = JSON.parse(await readFile(accountsFile, "utf8")) as Accounts;
else {
  accounts = { alice: randomBytes(12).toString("base64url"), bob: randomBytes(12).toString("base64url") };
  const operator = (...args: string[]) => {
    const result = spawnSync("npx", ["tsx", "scripts/admin/human-account.ts", dataDirectory, ...args], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) throw Error("Preview account setup failed");
  };
  for (const [user, role] of [
    ["alice", "admin"],
    ["bob", "member"],
  ] as const) {
    const passwordFile = join(privateDirectory, `${user}.password.json`);
    await writeFile(passwordFile, JSON.stringify({ password: accounts[user] }), { mode: 0o600 });
    try {
      operator("create", user, passwordFile);
      operator("grant", user, role);
    } finally {
      await rm(passwordFile, { force: true });
    }
  }
  await writeFile(accountsFile, JSON.stringify(accounts), { mode: 0o600 });
}

const server = await startHeadlessServer(
  {
    root,
    webRoot,
    dataDirectory,
    host: "127.0.0.1",
    port,
    humanAuthConfig: authFile,
    accessControl: true,
    dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
    codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? join(root, "runtime/codex/bin/codex"),
  },
  fixture
    ? {
        // The deterministic reception fixture stands in for a model; it shows the flow, not intelligence.
        personalAssistantHost: {
          readConfig: async () => ({
            maxRuntimes: 8,
            profileOptions: { mode: "fixture", telemetry: { enabled: false } },
          }),
        },
      }
    : {},
);

console.log(`
OpenCraft crew preview: ${server.url ?? origin}
Data: ${home}
Bots: ${fixture ? "deterministic fixture replies (no model)" : "the model chosen for each assistant in the Workbench"}

Sign in with two browser profiles (or one normal and one private window):
  alice / ${accounts.alice}   (instance admin; will own the Server)
  bob   / ${accounts.bob}   (member)

Try it:
  1. As alice: Assistants → New assistant (create one or two, e.g. Alan and Zhe).
  2. As alice: Inbox → Members → New team; then the team's settings (gear) to add the assistants
     as Agents, set each Agent's contacts and create an invitation link.
  3. As bob: Inbox → Members → Join a team, and paste the link.
  4. As bob: message an Agent from the team. That message is the dispatch.
  5. Inbox → Work shows it; the screen icon on a row opens the Agent's desk.
`);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
