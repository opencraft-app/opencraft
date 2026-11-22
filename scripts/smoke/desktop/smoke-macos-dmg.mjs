#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { APP_HOST_PROTOCOL_VERSION, CONNECT_APP_HOST_MESSAGE } from "@opencraft/app-host-protocol";

if (process.platform !== "darwin") throw new Error("DMG smoke requires macOS");
if (process.argv.length !== 3) throw new Error("Usage: node scripts/smoke/desktop/smoke-macos-dmg.mjs <final.dmg>");
const dmg = resolve(process.argv[2]);
// macOS has a 104-byte Unix-domain socket path buffer. The user-data directory
// owns the daemon socket, so keep the isolated profile under a short prefix.
const directory = await mkdtemp("/tmp/oc-dmg-");
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT || join(directory, "evidence"));
await mkdir(output, { recursive: true });
const command = promisify(execFile);
const run = (executable, args) => command(executable, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
const mount = join(directory, "volume");
let mounted = false;
let child;
let browser;
let launchError;
const log = await open(join(output, "launch.log"), "w");
const receipt = { image: basename(dmg), hostRoundTrip: false, passed: false };
try {
  await run("hdiutil", ["verify", dmg]);
  await mkdir(mount);
  await run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
  mounted = true;
  const apps = (await readdir(mount)).filter(name => name.endsWith(".app"));
  assert.equal(apps.length, 1, "DMG must contain one application");
  const app = join(directory, apps[0]);
  await run("ditto", [join(mount, apps[0]), app]);
  await run("hdiutil", ["detach", mount]);
  mounted = false;
  const verified = await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const signature = await run("codesign", ["--display", "--verbose=4", app]);
  await writeFile(join(output, "signature.log"), verified.stdout + verified.stderr + signature.stdout + signature.stderr);
  const profile = join(directory, "profile");
  const resources = join(app, "Contents", "Resources");
  await run(process.execPath, [fileURLToPath(new URL("./smoke-packaged-runtime.mjs", import.meta.url)), resources]);
  const fixture = new URL("../../../tests/fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).href;
  const executable = join(directory, "codex-fixture");
  await writeFile(executable, `#!/usr/bin/env node\nimport(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  await mkdir(join(directory, "home"));
  const environment = {
    ...process.env,
    HOME: join(directory, "home"),
    CODEX_HOME: join(directory, "native-codex"),
    OPENCRAFT_HOME: join(directory, "home"),
    OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(directory, "models"),
    OPENCRAFT_SKILLS_DIRECTORY: join(directory, "skills"),
    DSH_AGENTS_HOME: join(directory, "agents"),
    OPENCRAFT_PROJECTLESS_WORKSPACE_DIRECTORY: directory,
    OPENCRAFT_CODEX_EXECUTABLE: executable,
    OPENCRAFT_TEST_PACKAGED_TURN: "1",
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(join(app, "Contents", "MacOS", basename(app, ".app")), [
    `--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
  ], { env: environment, cwd: directory, detached: true, stdio: ["ignore", log.fd, log.fd] });
  child.on("error", error => { launchError = error; });
  const deadline = Date.now() + 60000;
  while (!browser && Date.now() < deadline) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, "Packaged Electron exited before its renderer was ready");
    assert.equal(child.signalCode, null, "Packaged Electron was killed before its renderer was ready");
    let port;
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); }
      catch { /* The port file can precede the listening endpoint. */ }
    }
    if (!browser) await delay(200);
  }
  assert.ok(browser, "Packaged Electron did not expose its renderer within 60 seconds");
  const context = browser.contexts()[0];
  const page = context.pages().find(page => page.url().startsWith("http://127.0.0.1:"))
    || await context.waitForEvent("page", { timeout: 30000 });
  await page.waitForFunction(() => Boolean(globalThis.opencraftDesktop)
    && Boolean(document.querySelector(".app-shell-header")), null, { timeout: 45000 });
  receipt.sourceRevision = await page.locator('meta[name="opencraft-source-revision"]').getAttribute("content");
  if (process.env.OPENCRAFT_SOURCE_REVISION) {
    assert.equal(receipt.sourceRevision, process.env.OPENCRAFT_SOURCE_REVISION, "packaged renderer source commit");
  }
  await page.screenshot({ path: join(output, "packaged-app.png") });
  const reply = await page.evaluate(async ({ connectType, protocolVersion, cwd }) => {
    const rendererId = crypto.randomUUID();
    const { port1, port2 } = new MessageChannel();
    const leaseId = crypto.randomUUID();
    const hostId = "local-codex";
    const frames = [];
    let fatal;
    let sequence = 0;
    port1.onmessage = ({ data }) => {
      if (data.type === "fatal") fatal = new Error(data.error.message);
      frames.push(data);
    };
    async function receive(predicate, label) {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (fatal) throw fatal;
        const message = frames.find(predicate);
        if (message) return message;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Packaged Host did not respond to ${label}`);
    }
    try {
      window.postMessage({ type: connectType, protocolVersion, rendererId }, location.origin, [port2]);
      port1.postMessage({ type: "hello", protocolVersion, rendererId });
      await receive(frame => frame.type === "ready", "hello");
      port1.postMessage({ type: "host/connect", requestId: "connect", hostId, leaseId });
      const connected = await receive(frame => frame.requestId === "connect", "host/connect");
      if (!connected.ok) throw new Error(connected.error.message);
      const generation = connected.result.generation;
      function send(rpc) {
        port1.postMessage({ type: "host/send", requestId: `frame-${++sequence}`, hostId, leaseId, generation, frame: JSON.stringify(rpc) });
      }
      function readFrame(frame) {
        return frame.type === "host/frame" && frame.hostId === hostId ? JSON.parse(frame.frame) : null;
      }
      async function rpc(method, params) {
        const id = sequence + 1;
        send({ id, method, params });
        const reply = readFrame(await receive(frame => {
          const result = readFrame(frame);
          return result?.id === id && !result.method;
        }, method));
        if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
        return reply.result;
      }
      await rpc("initialize", { clientInfo: { name: "desktop-package-smoke", version: "1" }, capabilities: { experimentalApi: true } });
      send({ method: "initialized" });
      const { thread } = await rpc("thread/start", { cwd, model: "gpt-test", approvalPolicy: "never", sandbox: "read-only", testNoServerRequest: true });
      const { turn } = await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Packaged Host smoke", text_elements: [] }] });
      const message = await receive(frame => {
        const notification = readFrame(frame);
        return notification?.method === "item/completed" && notification.params.turnId === turn.id
          && notification.params.item.type === "agentMessage";
      }, "assistant reply");
      await receive(frame => {
        const notification = readFrame(frame);
        return notification?.method === "turn/completed" && notification.params.turn.id === turn.id
          && notification.params.turn.status === "completed";
      }, "turn completion");
      return readFrame(message).params.item.text;
    } finally {
      port1.close();
    }
  }, { connectType: CONNECT_APP_HOST_MESSAGE, protocolVersion: APP_HOST_PROTOCOL_VERSION, cwd: directory });
  assert.equal(reply, "Fixture received: Packaged Host smoke");
  receipt.hostRoundTrip = true;
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(dmg)) digest.update(chunk);
  receipt.sha256 = digest.digest("hex");
  receipt.title = await page.title();
  receipt.passed = true;
  console.log("Final DMG verified; the installed renderer completed a Host turn with the isolated fixture");
} catch (error) {
  receipt.error = String(error.stack || error);
  throw error;
} finally {
  try { await browser?.close(); }
  finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await delay(1000);
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await log.close();
    await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    if (mounted) await run("hdiutil", ["detach", mount]);
    // Retain failed package/profile state on the runner for diagnosis.
    if (receipt.passed && !output.startsWith(directory + "/")) await rm(directory, { recursive: true, force: true });
  }
}
