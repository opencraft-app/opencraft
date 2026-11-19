// Launch the final AppImage with its embedded runtime on an isolated display/profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const image = process.argv[2];
if (!image || process.platform !== "linux") throw new Error("Usage on Linux: appimage-smoke.mjs FILE.AppImage");
const root = await mkdtemp(join(tmpdir(), "oc-appimage-"));
const profile = join(root, "profile");
const child = spawn(resolve(image), ["--appimage-extract-and-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
  cwd: root, detached: true, stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") },
});
let browser;
let rendered = false;
try {
  await once(child, "spawn");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const portFile = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    const [port, endpoint] = portFile.trim().split("\n");
    if (!browser && endpoint) browser = await chromium.connectOverCDP(`ws://127.0.0.1:${Number(port)}${endpoint}`, { timeout: 5000 });
    const page = browser?.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:/u.test(page.url()));
    if (page) {
      await page.waitForFunction(() => window.opencraftDesktop && document.querySelector("#root")?.childElementCount > 0, undefined, { timeout: 30_000 });
      rendered = true;
      console.log("Packaged AppImage rendered with its desktop preload.");
      break;
    }
    await delay(250);
  }
  assert.ok(rendered, "AppImage failed to open its desktop window");
} finally {
  try { await browser?.close(); } finally {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
}
