import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import("playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-agent-configuration";
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "agent-configuration", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith("/?")) return next();
    res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/agent-configuration.tsx"></script>');
  }); } }] });
await vite.listen(); const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
try {
  for (const touch of [false, true]) for (const theme of ["light", "dark", "lavender"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 940 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.goto(`${vite.resolvedUrls!.local[0]}?theme=${theme}`);
    await page.getByRole("tab", { name: "Agent 配置", exact: true }).waitFor();
    assert.equal(await page.getByRole("tab").allTextContents().then(rows => rows.join("|")), "Agent 配置|模型配置");
    assert.equal(await page.locator(".model-services__agent-entry").count(), 0);
    const group = page.locator(".agent-configuration__group").filter({ hasText: "Remote Linux" });
    const remote = group.locator("button").filter({ hasText: "Codex" }); await remote.waitFor();
    const click = async (locator: ReturnType<typeof page.locator>) => { if (touch) await locator.tap(); else await locator.click(); };
    await click(remote);
    const detail = page.locator(".agent-configuration__detail"); await detail.getByRole("heading", { name: "Codex", exact: true }).waitFor();
    assert((await detail.locator(".agent-configuration__location").innerText()).includes("Remote Linux"));
    await click(detail.getByRole("button", { name: "导入会话", exact: true }));
    await page.waitForFunction(() => (window as any).agentConfigurationFixture.calls.some((call: any) => call.host === "remote" && call.method === "opencraft/agents/onboarding/history" && call.params.id === "codex"));
    await click(detail.locator(".agent-history__folders button").first());
    await page.getByText("remote conversation", { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
    await page.getByRole("tab", { name: "模型配置", exact: true }).click();
    const key = page.locator("#model-service-key");
    if (!await key.isVisible()) await page.getByRole("button", { name: "编辑", exact: true }).click();
    await key.fill("synthetic-unsaved-key"); await key.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 8)); await key.evaluate(element => { (window as any).keptKeyInput = element; });
    await page.getByRole("tab", { name: "Agent 配置", exact: true }).click();
    assert((await detail.locator(".agent-configuration__location").innerText()).includes("Remote Linux"));
    await page.getByText("remote conversation", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "模型配置", exact: true }).click();
    assert.equal(await key.inputValue(), "synthetic-unsaved-key"); assert(await key.evaluate(element => element === (window as any).keptKeyInput));
    assert.equal(await key.evaluate((element: HTMLInputElement) => element.selectionStart), 3);
    // Arrow keys activate the preceding tab through the shared Tabs owner.
    await page.getByRole("tab", { name: "模型配置", exact: true }).focus(); await page.keyboard.press("ArrowLeft");
    assert.equal(await page.getByRole("tab", { name: "Agent 配置", exact: true }).getAttribute("aria-selected"), "true");
    // A background read failure keeps existing rows and offers a scoped retry.
    await page.evaluate(() => (window as any).agentConfigurationFixture.setRemoteReadFailure(true));
    await page.waitForFunction(() => [...document.querySelectorAll('.agent-configuration__directory-state')].some(el => el.textContent?.includes('无法加载此设备上的 Agent')));
    assert.equal(await page.locator(".agent-configuration__group").filter({ hasText: "Remote Linux" }).locator("button").filter({ hasText: "Codex" }).count(), 1);
    await page.evaluate(() => (window as any).agentConfigurationFixture.setRemoteReadFailure(false));
    await page.waitForFunction(() => ![...document.querySelectorAll('.agent-configuration__directory-state')].some(el => el.textContent?.includes('无法加载此设备上的 Agent')));
    // Import is executed against the selected remote Host while the left tree is locked.
    await click(page.getByRole("checkbox", { name: /remote conversation/ }));
    await page.evaluate(() => (window as any).agentConfigurationFixture.holdImport());
    await click(page.getByRole("button", { name: "导入所选会话（1）", exact: true }));
    await page.waitForFunction(() => (window as any).agentConfigurationFixture.calls.some((c: any) => c.method === "opencraft/agents/onboarding/import" && c.host === "remote" && c.params.id === "codex"));
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".agent-configuration__group button")).filter(el => el.textContent?.includes("Codex")).every(el => el.disabled));
    assert(await remote.isDisabled());
    await page.getByRole("tab", { name: "模型配置", exact: true }).click();
    await page.evaluate(() => (window as any).agentConfigurationFixture.releaseImport());
    await page.getByRole("tab", { name: "Agent 配置", exact: true }).click();
    await page.getByText(/已导入 1 个会话/).waitFor();
    await page.evaluate(() => { const f = (window as any).agentConfigurationFixture; f.setProfiles(f.baseProfiles.map((p: any) => p.hostId === "remote" ? { ...p, machinePresence: "offline" } : p)); });
    await detail.getByText("此设备已离线，重新连接后可配置 Agent 或导入会话。", { exact: true }).waitFor();
    assert.equal(await page.locator(".agent-configuration__group").filter({ hasText: "Remote Linux" }).locator("button").filter({ hasText: "Codex" }).count(), 1, "offline keeps the cached remote identity");
    assert(await detail.locator("[inert]").count());
    await page.evaluate(() => { const f = (window as any).agentConfigurationFixture; f.setProfiles(f.baseProfiles); });
    if (touch) await page.locator(".agent-configuration__mobile-back").getByRole("button").tap();
    await click(page.getByRole("button", { name: "接入远程机器", exact: true }));
    await detail.getByRole("button", { name: "生成 Bash 接入命令", exact: true }).waitFor();
    await click(detail.getByRole("button", { name: "生成 Bash 接入命令", exact: true })); await detail.getByText("echo synthetic-enrollment", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "模型配置", exact: true }).click(); await page.getByRole("tab", { name: "Agent 配置", exact: true }).click();
    await detail.getByText("echo synthetic-enrollment", { exact: true }).waitFor();
    const activeElement = await page.evaluateHandle(() => document.activeElement);
    await page.evaluate(() => (window as any).agentConfigurationFixture.setLocale("en-US"));
    await page.getByRole("heading", { name: "Model/Agent configuration", exact: true }).waitFor();
    assert.equal(await key.inputValue(), "synthetic-unsaved-key");
    assert.equal(await activeElement.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => (window as any).agentConfigurationFixture.calls.some((c: any) => /^(thread|turn)\//.test(c.method) || c.method === "runtime/providers/apply")), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); console.log("PASS Agent configuration", touch ? "touch" : "desktop", theme); await context.close();
  }
} finally { await browser.close(); await vite.close(); }
