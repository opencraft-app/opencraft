import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AppHostServer } from "@opencraft/app-host-server";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { SshCodexTransport } from "../apps/opencraft-daemon/src/ssh-codex-transport.js";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";
import { assertHeadlessWebRelease } from "./headless-web-release.mjs";

// Exercise the complete built Workbench. Only SSH exec is synthetic. Never
// bind a real credential, create a Thread or invoke an actual model here.
const webRoot = process.env.OPENCRAFT_SSH_UI_WEB_ROOT;
assert.ok(webRoot, "Set OPENCRAFT_SSH_UI_WEB_ROOT to an isolated headless Web build");
await assertHeadlessWebRelease(resolve(webRoot));
const calls: { hostId: string; method: string; params: any }[] = [];
const connections = new Map<string, number>();
const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport(hostId) {
  assert.ok(hostId === "ssh:fixture" || hostId === "local-codex");
  return new CodexEngineAdapter({ kind: "remote", logDiagnostic: () => undefined,
    transport: new SshCodexTransport({ hostname: "fixture.invalid", port: 22, username: "fixture",
      knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" },
      spawnSsh: (args, env) => {
        connections.set(hostId, (connections.get(hostId) ?? 0) + 1);
        const child = spawn(process.execPath, [new URL("../tests/fixtures/fake-codex-ssh-proxy.mjs", import.meta.url).pathname, args.at(-1)!], {
          stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...env, FIXTURE_WORKBENCH_UI: "1" },
        });
        child.on("message", (frame: any) => calls.push({ hostId, ...frame }));
        return child;
      },
    }) });
} });
let browser: any;
let activePage: any;
let web: Awaited<ReturnType<typeof createWorkbenchWebServer>> | undefined;
try {
  web = await createWorkbenchWebServer({ root: resolve(webRoot), loopbackOnly: true,
    appServerTarget: null, appHostServer: appHost,
    sshServerDescriptors: [{ serverId: "ssh:fixture", displayName: "Remote UI fixture", workspaceBrowseRoots: ["/remote"] }],
    onAppHostDiagnostic: () => undefined });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const errors: string[] = [];
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: mobile, isMobile: mobile, locale: "en-US" });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    activePage = page;
    page.on("pageerror", (error: Error) => errors.push(error.message));
    // A fabricated Draft ID is not a retained resource and cannot own startup
    // navigation. Select the remote through the actual product picker instead.
    await page.goto(origin);
    const target = page.getByRole("button", { name: "Choose execution node", exact: true });
    await target.waitFor({ timeout: 30_000 });
    await target.click();
    await page.getByRole("menuitem").filter({ hasText: "Remote UI fixture" }).waitFor();
    await page.locator(".new-thread-host-menu").getByRole("menuitem").filter({ hasText: /^Codex/u }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Choose execution node"]')?.textContent?.includes("Codex"));
    await target.click();
    await page.locator(".new-thread-host-menu").getByRole("menuitem").filter({ hasText: "Remote UI fixture" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Choose execution node"]')?.textContent?.includes("Remote UI fixture") && document.querySelector('[aria-label="Choose execution node"] .workbench-connection-status')?.getAttribute("data-phase") === "ready", undefined, { timeout: 30_000 });
    const editor = page.locator(".codex-composer-editor");
    await editor.fill("Draft survives target discovery");
    await target.click(); await page.keyboard.press("Escape");
    assert.equal(await editor.innerText(), "Draft survives target discovery");
    await page.getByRole("button", { name: "Choose project folder" }).click();
    await page.getByRole("menuitem", { name: /^Add project/ }).click();
    const directory = page.getByRole("dialog", { name: "Choose a folder", exact: true });
    await directory.getByRole("button", { name: "project", exact: true }).click();
    await directory.getByRole("button", { name: "Use folder", exact: true }).click();
    await directory.waitFor({ state: "hidden" });
    assert.match(await page.getByRole("button", { name: "Choose project folder" }).innerText(), /project/iu);
    assert.equal(await editor.innerText(), "Draft survives target discovery");
    await page.reload(); await target.waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Choose execution node"]')?.textContent?.includes("Remote UI fixture"), undefined, { timeout: 30_000 });
    assert.match(await target.innerText(), /Remote UI fixture/u);
    await page.goto(`${origin}/local/ssh-ui-thread?hostId=ssh%3Afixture`);
    await page.getByText("Remote history fixture", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.getByText("Historical remote answer", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await page.getByText("Historical remote question", { exact: true }).count(), 1);
    await page.reload();
    await page.getByText("Historical remote answer", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await page.getByText("Historical remote question", { exact: true }).count(), 1);
    await page.locator(".codex-composer-editor").waitFor();
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(connections.get("ssh:fixture"), 1, "page detach/reload cannot own the SSH connection");
  assert.ok(calls.some(call => call.hostId === "ssh:fixture" && call.method === "model/list"));
  assert.ok(calls.some(call => call.hostId === "ssh:fixture" && call.method === "thread/resume"));
  assert.ok(calls.some(call => call.hostId === "ssh:fixture" && call.method === "fs/readDirectory" && call.params.path === "/remote/project"));
  assert.ok(calls.every(call => !["thread/start", "turn/start", "turn/steer", "fs/writeFile"].includes(call.method)));
  console.log(JSON.stringify({ ok: true, actualWorkbenchUI: true, desktop: true, touch: true,
    backendCatalog: true, remoteSelection: true, targetReload: true, draftRetainedDuringSelection: true,
    remoteDirectorySelection: true, historyRestore: true,
    sharedPhysicalConnection: true, sshExecFixture: true, realRemoteWrites: false }));
} catch (error) {
  // Only this synthetic profile is reachable; no user history/credential data
  // is loaded into the fixture. Keep failed UI sequences diagnosable.
  console.error(JSON.stringify({ fixtureUi: await activePage?.locator("body").innerText(), methods: calls.map(call => [call.hostId, call.method]), errors: String(error) }));
  throw error;
} finally { await browser?.close(); await web?.close(); await appHost.close(); }
