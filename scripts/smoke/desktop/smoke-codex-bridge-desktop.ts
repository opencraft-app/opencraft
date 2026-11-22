// The Electron desktop from current source on the Codex bridge stack, driven
// over CDP: a new conversation answered by the local stand-in model, then quit,
// with every process of the profile gone afterwards (daemon, bridge stack,
// terminal owner) and the DevTools port released. Synthetic account only.
//
//   npm run build:electron
//   node --import tsx scripts/smoke/desktop/smoke-codex-bridge-desktop.ts [--step <module>]... [--keep]
//
// --step runs further scenarios after the first one: modules whose default
// export is `async (page, context) => result`. --keep leaves the app running
// for manual CDP work and prints how to reach and stop it. On Linux without a
// display it runs under xvfb-run. Output: .local/codex-bridge-desktop/<time>/.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect, createServer, type AddressInfo } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { startFakeResponsesModel } from "../../../tests/fixtures/fake-responses-model.mjs";
import { drillCodexExecutable, prepareDrillPrograms, repositoryRoot } from "../execution/codex-bridge-drill-setup.mjs";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const steps = process.argv.flatMap((value, index) => (process.argv[index - 1] === "--step" ? [resolve(value)] : []));
const keep = process.argv.includes("--keep");

const out = join(repositoryRoot, ".local/codex-bridge-desktop", new Date().toISOString().replace(/[:.]/gu, "-"));
const profile = join(out, "profile");
await mkdir(join(profile, "codex"), { recursive: true });
const result: Record<string, unknown> = { out };
const save = () => writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");

const programs = await prepareDrillPrograms(join(out, "programs"));
const codex = await drillCodexExecutable();
const requests: unknown[] = [];
const model = await startFakeResponsesModel({ onRequest: (entry) => requests.push(entry) });
const store = new AccountPoolStore({
  databasePath: join(profile, "codex", "account-pool.sqlite"),
  secretsDirectory: join(profile, "codex", "secrets"),
});
store.addAccount(
  {
    id: "synthetic",
    provider: "codex",
    label: "Synthetic",
    upstreamAccountId: "synthetic",
    enabled: true,
    priority: 0,
  },
  { accessToken: "synthetic-no-upstream-access", refreshToken: null, expiresAt: null },
);
store.close();

const port = await new Promise<number>((done) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => done(port));
  });
});
const electronArgs = [
  join(repositoryRoot, "scripts/dev/start-electron.mjs"),
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
];
const headless = process.platform === "linux" && !process.env.DISPLAY;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_OPTIONS: "",
  OPENCRAFT_HOME: join(out, "opencraft-home"),
  CODEX_HOME: join(out, "codex-home"),
  OPENCRAFT_CODEX_BRIDGE: "1",
  OPENCRAFT_CODEX_BRIDGE_PROGRAMS: programs,
  OPENCRAFT_CODEX_EXECUTABLE: codex,
  OPENCRAFT_DRILL_UPSTREAM: model.url,
};
const app = headless
  ? spawn("xvfb-run", ["-a", "-s", "-screen 0 1440x900x24", process.execPath, ...electronArgs], {
      cwd: repositoryRoot,
      env,
      stdio: "ignore",
    })
  : spawn(process.execPath, electronArgs, { cwd: repositoryRoot, env, stdio: "ignore" });
console.log(`desktop on CDP port ${port}, profile ${profile}`);

const portOpen = () =>
  new Promise<boolean>((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("error", () => done(false));
  });
/** Processes still running with the profile on their command line (POSIX; Windows is not listed). */
const profileProcesses = () => {
  if (process.platform === "win32") return [];
  return execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(profile) && !line.includes("xvfb-run"));
};

let failed = false;
try {
  for (let attempt = 0; !(await portOpen()); attempt++) {
    if (attempt > 120) throw new Error("The desktop did not open its DevTools port");
    await delay(500);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith("devtools"));
  for (let attempt = 0; !page && attempt < 60; attempt++) {
    await delay(500);
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => !candidate.url().startsWith("devtools"));
  }
  if (!page) throw new Error("No desktop window");
  page.setDefaultTimeout(30_000);
  const context = { out, model, requests, profile };

  // A new conversation on the stand-in model, answered through the bridge.
  await page.getByText("New chat", { exact: true }).click();
  await page.waitForTimeout(800);
  if (!(await page.getByText(/Fake GPT/u).count())) {
    await page
      .getByRole("button", { name: /Claude Code|Fake GPT|Model/u })
      .first()
      .click();
    await page.locator('[role="tab"]').nth(1).click();
    await page.getByText("Fake GPT", { exact: true }).first().click();
  }
  const editor = page.locator(".opencraft-composer-editor");
  await editor.click();
  await editor.fill("DESKTOP-HELLO from the drill");
  await page.keyboard.press("Enter");
  await page.getByText("echo: DESKTOP-HELLO from the drill", { exact: true }).waitFor({ timeout: 90_000 });
  await page.screenshot({ path: join(out, "new-conversation.png") });
  result.newConversation = "answered";
  console.log("new conversation answered");

  for (const step of steps) {
    const run = (await import(pathToFileURL(isAbsolute(step) ? step : resolve(step)).href)).default;
    result[step] = (await run(page, context)) ?? "done";
    await save();
  }

  if (keep) {
    console.log(`kept running: CDP http://127.0.0.1:${port}; stop it with: kill ${app.pid}`);
    await save();
    process.exit(0);
  }
  // Quit as a user would; the browser process ends the app.
  console.log("quitting");
  const session = await browser.newBrowserCDPSession();
  await Promise.race([session.send("Browser.close").catch(() => undefined), delay(5000)]);
  for (let attempt = 0; await portOpen(); attempt++) {
    if (attempt > 40) throw new Error("The DevTools port is still open after quitting");
    await delay(500);
  }
  result.devtoolsPortReleased = true;
  console.log("DevTools port released; waiting for the profile's processes to end");
  // The terminal owner leaves 60 s after its last Host; everything else at quit.
  let left = profileProcesses();
  for (let attempt = 0; left.length && attempt < 100; attempt++) {
    await delay(1000);
    left = profileProcesses();
  }
  if (left.length) throw new Error(`Processes left after quitting:\n${left.join("\n")}`);
  result.processesAfterQuit = 0;
} catch (error) {
  failed = true;
  result.failure = error instanceof Error ? error.message : String(error);
} finally {
  result.modelRequests = requests.length;
  await save();
  if (!keep || failed) app.kill();
  await model.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(failed ? 1 : 0);
