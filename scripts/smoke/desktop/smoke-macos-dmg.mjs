#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

if (process.platform !== "darwin") throw new Error("DMG smoke requires macOS");
if (process.argv.length !== 3) throw new Error("Usage: node scripts/smoke/desktop/smoke-macos-dmg.mjs <final.dmg>");
const dmg = resolve(process.argv[2]);
const directory = await mkdtemp(join(tmpdir(), "opencraft-dmg-smoke-"));
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
const receipt = { image: basename(dmg), sourceRevision: process.env.OPENCRAFT_SOURCE_REVISION, passed: false };
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
  const environment = {
    ...process.env,
    OPENCRAFT_HOME: join(directory, "home"),
    OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(directory, "models"),
    OPENCRAFT_SKILLS_DIRECTORY: join(directory, "skills"),
    DSH_AGENTS_HOME: join(directory, "agents"),
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
  await page.screenshot({ path: join(output, "packaged-app.png") });
  receipt.title = await page.title();
  receipt.passed = true;
  console.log("Final DMG verified; copied application signature and real Electron renderer passed");
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
