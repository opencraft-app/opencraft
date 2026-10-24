import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { electronLaunchSpec } from "../start-electron.mjs";

/** Only starts and stops this fixture's process, never an installed/user instance. */
export async function launchIsolatedElectron(root: string) {
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = { ...process.env, OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(root, "models"), OPENCRAFT_SKILLS_DIRECTORY: join(root, "skills"), DSH_AGENTS_HOME: join(root, "agents") };
  delete env.OPENCRAFT_DSH_URL; delete env.OPENCRAFT_DSH_REPOSITORY;
  const spec = electronLaunchSpec([`--user-data-dir=${join(root, "profile")}`, `--remote-debugging-port=${port}`], env);
  const child = spawn(spec.executable, spec.args, { ...spec.options, stdio: "ignore" });
  let browser: any;
  async function stop() {
    await browser?.close(); browser = undefined;
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    });
  }
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Isolated Electron exited before startup");
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    if (!browser) throw new Error("Isolated Electron startup deadline exceeded");
    const context = browser.contexts()[0];
    const page = context.pages().find((p: any) => p.url().startsWith("http://127.0.0.1:")) ?? await context.waitForEvent("page");
    await page.waitForFunction(() => !!(globalThis as any).opencraftDesktop?.extensionData);
    return { page, stop };
  } catch (error) { await stop(); throw error; }
}
