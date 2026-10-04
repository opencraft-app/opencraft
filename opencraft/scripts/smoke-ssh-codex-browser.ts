import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { AppHostServer } from "@opencraft/app-host-server";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { SshCodexTransport } from "../apps/opencraft-daemon/src/ssh-codex-transport.js";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";

// Actual browser AppHost Client and AppServerClient. Only the remote SSH exec
// boundary is synthetic; it still speaks real HTTP/WebSocket bytes.
const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-browser-"));
let processes = 0;
const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport(hostId) {
  assert.equal(hostId, "ssh:fixture");
  return new CodexEngineAdapter({ kind: "remote", logDiagnostic: () => undefined, transport: new SshCodexTransport({
    hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" },
    spawnSsh: (args, env) => { processes++; return spawn(process.execPath, [new URL("../tests/fixtures/fake-codex-ssh-proxy.mjs", import.meta.url).pathname, args.at(-1)!], { stdio: ["pipe", "pipe", "pipe"], env }); },
  }) });
} });
let web: Awaited<ReturnType<typeof createWorkbenchWebServer>> | undefined;
let browser: any;
try {
  await build({ stdin: { contents: `
    import {connectWebSocketAppHost} from './apps/workbench-web/src/runtime/websocket-app-host.ts';
    import {JsonRpcAppServerClient} from '@opencraft/appserver-client';
    import {parseSshCodexServerDescriptors} from '@opencraft/app-host-protocol';
    const hub=connectWebSocketAppHost();let client;
    window.probe={async connect(){const catalog=parseSshCodexServerDescriptors(await (await fetch('/__opencraft_ssh_servers')).json());
      client=new JsonRpcAppServerClient({hostId:catalog[0].serverId,transport:hub.createTransport(catalog[0].serverId),createRequestId:()=>1});
      await client.connect({clientInfo:{name:'browser-smoke',version:'0.1'},capabilities:{experimentalApi:true}});
      const models=await client.request('model/list',{});const threads=await client.request('thread/list',{limit:1});
      return {catalog,models,threads};},async read(){return client.request('thread/list',{limit:1});},async close(){await client.close();hub.close();}};
    `, resolveDir: process.cwd(), loader: "ts" }, bundle: true, format: "esm", platform: "browser", outfile: join(directory, "probe.js") });
  await writeFile(join(directory, "index.html"), '<meta name="viewport" content="width=device-width,initial-scale=1"><title>SSH Client smoke</title><script type="module" src="/probe.js"></script>');
  web = await createWorkbenchWebServer({ root: directory, loopbackOnly: true, appServerTarget: null, appHostServer: appHost,
    sshServerDescriptors: [{ serverId: "ssh:fixture", displayName: "Remote fixture", workspaceBrowseRoots: ["/remote"] }], onAppHostDiagnostic: () => undefined });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const errors: string[] = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const first = await context.newPage(); const second = await context.newPage();
  for (const page of [first, second]) { page.on("pageerror", (error: Error) => errors.push(error.message)); await page.goto(origin); await page.waitForFunction(() => !!(window as any).probe); }
  const result = await Promise.all([first.evaluate(() => (window as any).probe.connect()), second.evaluate(() => (window as any).probe.connect())]);
  assert.equal(processes, 1);
  for (const response of result) { assert.equal(response.catalog[0].serverId, "ssh:fixture"); assert.deepEqual(response.models.data, []); assert.deepEqual(response.threads.data, []); }
  await first.close();
  assert.deepEqual(await second.evaluate(() => (window as any).probe.read()), { data: [], nextCursor: null });
  await second.reload(); await second.waitForFunction(() => !!(window as any).probe);
  await second.evaluate(() => (window as any).probe.connect()); assert.equal(processes, 1);
  await second.evaluate(() => (window as any).probe.close()); await context.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, realBrowserClient: true, sshExecFixture: true, sharedPhysicalConnection: true, pageDetach: true, reload: true, remoteWrites: false, actualWorkbenchUI: false }));
} finally {
  await browser?.close(); await web?.close(); await appHost.close();
  await rm(directory, { recursive: true, force: true });
}
