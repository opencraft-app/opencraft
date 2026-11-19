import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { navigationLifecycleFixture } from "../fixtures/navigation-lifecycle";
const root = process.cwd(),
  output = resolve(".local/managed-bots");
let source =
  `window.botTemplates=[];window.botWrites=[];window.botRows=[];window.failCreate=true;const makeBot=(p)=>({assistant:{name:p.name,duties:p.duties,environment:p.environment,isDefault:false,paused:false,configRevision:0,modelRevision:0,model:null,actorId:'session://test/'+p.name,binding:{serverId:'test',botId:p.name,assignmentId:'assignment-'+p.name,owner:{kind:'human',id:'me'}},state:'claimed',createdAt:Date.now()},runtime:{phase:'config_required'},channelId:null});\n` +
  navigationLifecycleFixture;
source = source.replaceAll(
  "navigation.openExtensionView('opencraft.im.people')",
  "navigation.openExtensionView('opencraft.im.agents')",
);
source = source.replace(
  "request:async(method,p)=>{",
  `request:async(method,p)=>{
 if(method==='opencraft/personal-assistant/bots/list')return{bots:window.botRows};
 if(method==='opencraft/personal-assistant/environments')return{local:true,templates:window.botTemplates};
 if(method==='opencraft/personal-assistant/bots/create'){window.botWrites.push({method,...p});if(window.failCreate){window.failCreate=false;throw Error('connection_lost');}const row=makeBot(p);window.botRows.push(row);return row;}
 if(method==='opencraft/personal-assistant/bots/update'){window.botWrites.push({method,...p});const row=window.botRows.find(b=>b.assistant.binding.botId===p.botId);Object.assign(row.assistant,{name:p.name,duties:p.duties,environment:p.environment,configRevision:row.assistant.configRevision+1});return row;}
 if(method==='opencraft/personal-assistant/bots/pause'){window.botWrites.push({method,...p});const row=window.botRows.find(b=>b.assistant.binding.botId===p.botId);row.assistant.paused=p.paused;row.assistant.configRevision++;return row;}
 if(method==='opencraft/personal-assistant/models')return{available:true,models:[{providerId:'test',modelId:'m',label:'Test model'}]};
 if(method==='opencraft/personal-assistant/threads/profiles')return{profiles:[]};
 if(method==='opencraft/personal-assistant/threads/sources')return{conversations:[],nextCursor:null};
`,
);
const server = await createServer({
  root,
  configFile: false,
  publicDir: root + "/apps/workbench-web/public",
  logLevel: "error",
  cacheDir: output + "/vite-cache",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "managed-bots-fixture",
      resolveId: (id) => (id === "/bots-fixture.tsx" ? id : null),
      load: (id) => (id === "/bots-fixture.tsx" ? source : null),
      configureServer(v) {
        v.middlewares.use((req, res, next) => {
          if (!req.headers.accept?.includes("text/html")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/bots-fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const results = [];
  for (const touch of [false, true])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: touch ? 390 : 1280, height: 900 },
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("http://127.0.0.1:" + (server.httpServer!.address() as any).port + "/?theme=" + theme);
      await page.getByRole("button", { name: "Open Inbox", exact: true }).click();
      const area = page.locator(".managed-bots");
      await area.getByRole("button", { name: "New assistant", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Engineer");
      await dialog.getByRole("textbox", { name: "Responsibilities", exact: true }).fill("Build and verify");
      await dialog.getByText("E2B templates appear", { exact: false }).waitFor();
      await dialog.getByRole("button", { name: "New assistant", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      await dialog.getByRole("button", { name: "New assistant", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      let writes = await page.evaluate(() => (window as any).botWrites);
      assert.equal(writes[0].clientRequestId, writes[1].clientRequestId);
      assert.deepEqual(writes[1].environment, { kind: "local" });
      await area.getByRole("button", { name: "New assistant", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Designer");
      await dialog.getByRole("button", { name: "New assistant", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await area.locator(".managed-bots__row").count(), 2);
      const engineer = area.locator(".managed-bots__row").filter({ has: page.getByText("Engineer", { exact: true }) });
      await engineer.getByRole("button", { name: "Pause", exact: true }).click();
      await engineer.getByRole("button", { name: "Resume", exact: true }).waitFor();
      writes = await page.evaluate(() => (window as any).botWrites);
      assert.equal(writes.at(-1).botId, "Engineer");
      assert.equal(writes.at(-1).paused, true);
      await engineer.getByRole("button", { name: "Settings", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Engineer updated");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await area.getByText("Engineer updated", { exact: true }).waitFor();
      writes = await page.evaluate(() => (window as any).botWrites);
      assert.equal(writes.at(-1).botId, "Engineer");
      await area.getByRole("button", { name: "New assistant", exact: true }).click();
      await dialog
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("A long name for an independent assistant that wraps without hiding controls");
      await page.evaluate(
        () => ((window as any).botTemplates = [{ backendId: "e2b", id: "approved", name: "Approved template" }]),
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await area.getByRole("button", { name: "New assistant", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Remote engineer");
      await dialog.getByRole("button", { name: "Work environment", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "E2B · Approved template", exact: true }).click();
      await dialog.getByText("This workspace is temporary", { exact: false }).waitFor();
      await page.locator(".ui-choice-select__menu").waitFor({ state: "hidden" });
      await page.screenshot({ path: output + "/" + (touch ? "touch" : "mouse") + "-" + theme + ".png" });
      assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
      await dialog.getByRole("button", { name: "New assistant", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      writes = await page.evaluate(() => (window as any).botWrites);
      assert.deepEqual(writes.at(-1).environment, { kind: "sandbox", backendId: "e2b", templateId: "approved" });
      assert.deepEqual(errors, []);
      results.push({
        touch,
        theme,
        createRetryStable: true,
        independentTargets: true,
        settings: true,
        noUnsupportedE2B: true,
        approvedE2BSelection: true,
        ephemeralWarning: true,
      });
      await context.close();
    }
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await browser?.close();
  await server.close();
}
