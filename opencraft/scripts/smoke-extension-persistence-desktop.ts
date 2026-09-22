import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchIsolatedElectron } from "./support/isolated-electron.ts";

const root = await mkdtemp("/tmp/oc-extension-desktop-");
const evidence: string[] = [];
const pluginId = "fixture.desktop-storage";
const host = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/javascript"); res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(`export default { manifest: { manifestVersion:1, id:"${pluginId}", name:"Isolated storage fixture", version:"1.0.0", apiVersion:1, trust:"trusted", platforms:["electron"], activationEvents:["onStartupFinished"] },
    async activate(api) {
      const document = await api.storage.open("state");
      const snapshot = await document.read();
      await document.compareAndSet(snapshot.revision, { launches: (snapshot.value.launches || 0) + 1 });
    } };`);
});
await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
const moduleUrl = `http://127.0.0.1:${(host.address() as { port: number }).port}/plugin.js`;
let app: Awaited<ReturnType<typeof launchIsolatedElectron>> | undefined;
const load = (page: any, scope: string) => page.evaluate((scope: string) => (globalThis as any).opencraftDesktop.extensionData.read(scope), scope);
async function waitForRecord(page: any, scope: string, ready: (value: any) => boolean) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await load(page, scope);
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Fixture record not ready: ${scope}; UI: ${(await page.locator("body").innerText()).slice(0, 1200)}`);
}
try {
  app = await launchIsolatedElectron(root);
  const firstOrigin = new URL(app.page.url()).origin;
  const initial = await waitForRecord(app.page, "system/installations", value => !!value);
  const installed = await app.page.evaluate(async ({ revision, pluginId, moduleUrl }: any) => {
    return (globalThis as any).opencraftDesktop.extensionData.compareAndSet("system/installations", revision, 1,
      [{ extensionId: pluginId, source: { kind: "module-url", url: moduleUrl }, enabled: true, installedAt: 1, updatedAt: 1 }]);
  }, { revision: initial.revision, pluginId, moduleUrl });
  assert.equal(installed.updated, true);
  await app.stop(); app = undefined;
  // Occupy the previous fixture origin to prove restored storage is not origin-bound.
  const oldOrigin = createServer();
  await new Promise<void>((resolve, reject) => { oldOrigin.once("error", reject); oldOrigin.listen(Number(new URL(firstOrigin).port), "127.0.0.1", resolve); });
  try { app = await launchIsolatedElectron(root); }
  finally { await new Promise<void>(resolve => oldOrigin.close(() => resolve())); }
  assert.notEqual(new URL(app.page.url()).origin, firstOrigin);
  const scope = `plugin/${pluginId}/state`;
  await waitForRecord(app.page, scope, value => value?.value.data.launches === 1);
  evidence.push("different real Electron origin restored installed module and activated it through actual SDK/storage/Main IPC");
  const snapshot = await load(app.page, scope);
  const rejected = await app.page.evaluate(({ scope, revision }: any) => (globalThis as any).opencraftDesktop.extensionData.compareAndSet(scope, revision - 1, 1, {}), { scope, revision: snapshot.revision });
  assert.equal(rejected.updated, false);
  await app.page.screenshot({ path: join(root, "desktop-restored.png") });
  await app.stop(); app = await launchIsolatedElectron(root);
  await waitForRecord(app.page, scope, value => value?.value.data.launches === 2);
  evidence.push("second native restart retained plugin document; stale CAS rejected; no real account or inference");
  console.log(JSON.stringify({ root, evidence }, null, 2));
} finally { await writeFile(join(root, "report.json"), JSON.stringify({ evidence }, null, 2)); await app?.stop(); await new Promise<void>(resolve => host.close(() => resolve())); }
