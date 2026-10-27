import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = ".local/bot-management-policy";
const bundle = await build({ alias: { react: resolve("node_modules/react"), "react-dom": resolve("node_modules/react-dom") },
  entryPoints: ["tests/fixtures/bot-management-policy.tsx"], bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  loader: { ".scss": "empty", ".css": "empty" } });
const assets = resolve("apps/workbench-web/dist/assets");
const css = Buffer.concat(await Promise.all((await readdir(assets)).filter(name => name.endsWith(".css")).map(name => readFile(join(assets, name)))));
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0]!.contents); }
  else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>'); }
});
let browser: any;
try {
  await mkdir(output, { recursive: true });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } }); page.setDefaultTimeout(12000);
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  await page.goto(origin);
  await page.getByRole("status").waitFor();
  const ready = (hostId: string) => ({ hostId, phase: "ready", canManageBots: true, error: null });
  const configure = (ids: string[], states: any[], kind?: string, revision?: number) => page.evaluate(({ ids, states, kind, revision }) =>
    (window as any).botPolicyProof.configure(ids, states, kind, revision), { ids, states, kind, revision });
  // A held connection must not block another target or refresh after retirement.
  await configure(["b"], [ready("b")]);
  await page.getByRole("button", { name: "Bot b", exact: true }).waitFor();
  await page.waitForFunction(() => !(document.querySelector('[aria-label="刷新 Bot"]') as HTMLButtonElement)?.disabled);
  await page.evaluate(() => (window as any).botPolicyProof.settle("connect:a"));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.evaluate(() => (window as any).botPolicyProof.calls.some((c: any) => c.kind === "refresh" && c.hostId === "a")), false);
  // Preserve an operation draft and its captured mutation target across selection.
  await page.getByRole("button", { name: "Bot b 的操作" }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Bot 名称" }); await name.fill("Keep my draft");
  await configure(["c"], [ready("c")]);
  assert.equal(await name.inputValue(), "Keep my draft");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => (window as any).botPolicyProof.calls.find((c: any) => c.kind === "update")?.hostId), "b");
  // Old group reads and old errors cannot project into a newly selected Host.
  await page.evaluate(() => { (window as any).botPolicyProof.hold.add("groups:d"); });
  await configure(["d"], [ready("d")]);
  await page.waitForFunction(() => (window as any).botPolicyProof.calls.some((c: any) => c.kind === "groups" && c.hostId === "d"));
  await configure(["e"], [ready("e")]);
  await page.getByRole("button", { name: "Bot e", exact: true }).waitFor();
  await page.evaluate(() => (window as any).botPolicyProof.settle("groups:d"));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.getByText("Group groups:d", { exact: true }).count(), 0);
  await page.evaluate(() => { (window as any).botPolicyProof.hold.add("connect:f"); });
  await configure(["f"], []);
  await page.getByRole("status").waitFor();
  await configure(["g"], [ready("g")]);
  await page.getByRole("button", { name: "Bot g", exact: true }).waitFor();
  await page.evaluate(() => (window as any).botPolicyProof.settle("connect:f", true));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.getByText("Late old Host failure", { exact: true }).count(), 0);
  // Reusing a Host ID with a new profile revision retires old reads too.
  await page.evaluate(() => { (window as any).botPolicyProof.hold.add("groups:h"); });
  await configure(["h"], [ready("h")], undefined, 1);
  await page.waitForFunction(() => (window as any).botPolicyProof.calls.some((c: any) => c.kind === "groups" && c.hostId === "h"));
  await page.evaluate(() => { (window as any).botPolicyProof.hold.delete("groups:h"); });
  await configure(["h"], [ready("h")], undefined, 2);
  await page.waitForFunction(() => (window as any).botPolicyProof.calls.filter((c: any) => c.kind === "connect" && c.hostId === "h").length === 2);
  await page.evaluate(() => (window as any).botPolicyProof.settle("groups:h"));
  await page.waitForFunction(() => !(document.querySelector('[aria-label="刷新 Bot"]') as HTMLButtonElement)?.disabled);
  assert.equal(await page.getByText("Group groups:h", { exact: true }).count(), 0);
  // Generic ambiguity, empty policy and immutable extension assembly.
  const before = await page.evaluate(() => (window as any).botPolicyProof.calls.filter((c: any) => c.kind === "connect").length);
  await configure(["x", "y"], []);
  await page.getByText("存在多个 Agent，暂时无法确定 Bot 所属实例。", { exact: true }).waitFor();
  await configure(["b"], [], "restricted");
  await page.getByText("Product has no eligible Agent", { exact: true }).waitFor();
  await configure(["a"], [], "empty");
  await page.getByText("添加 Agent 后，可在此管理 Bots。", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).botPolicyProof.calls.filter((c: any) => c.kind === "connect").length), before);
  await configure(["z"], [ready("z")], "generic");
  await page.getByRole("button", { name: "Bot z", exact: true }).waitFor();
  for (const theme of ["light", "dark"]) for (const width of [1100, 390]) {
    await page.evaluate(theme => (window as any).botPolicyProof.theme(theme), theme);
    await page.setViewportSize({ width, height: 780 });
    const box = await page.locator(".bot-management").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1);
    await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(`${output}/browser.json`, JSON.stringify({ calls: await page.evaluate(() => (window as any).botPolicyProof.calls), errors, external }, null, 2));
  console.log("PASS actual Bot management: generic policy, immutable product assembly, ambiguity/empty eligibility, StrictMode held connection, late groups/errors, retained draft/target, light/dark desktop/mobile; I/O simulated.");
} finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
