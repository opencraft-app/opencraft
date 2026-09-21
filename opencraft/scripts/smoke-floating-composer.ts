import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const { _electron } = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const root = await mkdtemp("/tmp/oc-floating-");
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<title>Overlay fixture</title><style>body{height:100vh;margin:0;background:#eee}</style><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button>'
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
const env = {
  ...process.env,
  OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(root, "models"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  executablePath:
    process.env.OPENCRAFT_ELECTRON_EXECUTABLE ??
    resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  args: [
    ...(process.env.OPENCRAFT_PACKAGED_SMOKE === "1"
      ? []
      : [resolve("apps/workbench-electron")]),
    `--user-data-dir=${join(root, "profile")}`,
  ],
  env,
});
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.locator(".codex-composer-editor").waitFor({ timeout: 30000 });
  await page.evaluate("globalThis.__name = value => value");
  const editor = page.locator(".codex-composer-editor");
  await editor.fill("Stable native draft");
  await editor.evaluate(
    (element: HTMLElement) => ((window as any).__originalEditor = element)
  );
  const show = page.getByRole("button", {
    name: "Show task details",
    exact: true,
  });
  if (await show.isVisible()) await show.click();
  await page
    .getByRole("button", { name: "New browser tab", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Web address" })
    .fill(`http://127.0.0.1:${address.port}`);
  await page.getByRole("textbox", { name: "Web address" }).press("Enter");
  await page.waitForTimeout(700);
  const guest = page.locator("webview").filter({ visible: true }).first();
  const backing = await guest.evaluate((g: any) => g.getWebContentsId());
  await page
    .getByRole("button", { name: "Maximize panel", exact: true })
    .click();
  const content = page.locator(".thread-composer-overlay__content");
  await content.waitFor();
  await page.waitForTimeout(650);
  assert.equal(await content.getAttribute("data-density"), "compact");
  assert.equal(
    await editor.evaluate(
      (e: HTMLElement) => e === (window as any).__originalEditor
    ),
    true
  );
  assert.equal(await editor.innerText(), "Stable native draft");
  await editor.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".thread-composer-overlay__content")
        ?.getAttribute("data-density") === "expanded"
  );
  await page.waitForTimeout(220);
  const wide = await content.boundingBox();
  assert.ok(wide!.width > 400);
  const transition = await content.evaluate(
    (e: HTMLElement) => getComputedStyle(e).transitionDuration
  );
  assert.notEqual(
    transition,
    "0s",
    "source width animation has a resolved easing token"
  );
  await page.locator(".codex-composer-mode--permissions").click();
  await page.getByRole("menu", { name: "Permissions", exact: true }).waitFor();
  assert.equal(
    await content.getAttribute("data-density"),
    "expanded",
    "Radix menu belongs to composer focus"
  );
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "Permissions", exact: true }).waitFor({ state: "detached" });
  const handle = page.getByRole("button", {
    name: "Hide chat input",
    exact: true,
  });
  const hideBox = await handle.boundingBox();
  assert.ok(
    hideBox!.width <= 40 && hideBox!.height <= 16,
    "hide is a handle, not a footer row"
  );
  // Focus departure to the browser returns compact, never destroys the editor.
  await page.getByRole("textbox", { name: "Web address" }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".thread-composer-overlay__content")
        ?.getAttribute("data-density") === "compact"
  );
  await editor.click();
  await page.waitForTimeout(200);
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows().find((w: any) => w.webContents.getURL().startsWith('http'))?.focus());
  const surfaceBounds = await guest.boundingBox();
  await page.mouse.click(surfaceBounds!.x + 100, surfaceBounds!.y + 80);
  await page.waitForFunction(() => document.querySelector('.thread-composer-overlay__content')?.getAttribute('data-density') === 'compact');
  await editor.click(); await page.waitForTimeout(200);
  await handle.click();
  await page.waitForTimeout(200);
  assert.equal(
    await editor.evaluate((e: HTMLElement) => Boolean(e.closest("[inert]"))),
    true
  );
  await page
    .getByRole("button", { name: "New browser tab", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const originalTab = page.getByRole("tab", { name: "Overlay fixture", exact: true });
  await originalTab.focus();
  await originalTab.press("Enter");
  await page.waitForTimeout(200);
  assert.equal(
    await content.getAttribute("data-peeked"),
    "true",
    "switching tabs preserves manual collapse: " + await page.locator('.thread-composer-overlay').evaluate((e: HTMLElement) => JSON.stringify(e.dataset))
  );
  const reveal = page.getByRole("button", {
    name: "Show chat input",
    exact: true,
  });
  // Native guest input event, not a synthetic host pointer event.
  const guestBox = await guest.boundingBox();
  await page.mouse.move(guestBox!.x + 40, guestBox!.y + 40);
  await page.waitForTimeout(200);
  await page.mouse.move(
    guestBox!.x + guestBox!.width / 2,
    guestBox!.y + guestBox!.height - 10
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="floating-composer-reveal-handle"]')
        ?.getAttribute("data-active") === "true"
  );
  await reveal.click();
  await page.waitForTimeout(220);
  assert.equal(await editor.innerText(), "Stable native draft");
  assert.equal(
    await editor.evaluate(
      (e: HTMLElement) => e === (window as any).__originalEditor
    ),
    true
  );
  // Toolbar and handle consume the same scope state.
  await page
    .getByRole("button", { name: "Hide floating composer", exact: true })
    .click();
  await content.waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Show floating composer", exact: true })
    .click();
  await content.waitFor();
  await page.waitForTimeout(200);
  assert.equal(
    await editor.evaluate(
      (e: HTMLElement) => e === (window as any).__originalEditor
    ),
    true
  );
  await editor.focus();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(root, "expanded.png") });
  await page
    .getByRole("button", { name: "Restore panel", exact: true })
    .click();
  await page.waitForTimeout(60);
  await page
    .getByRole("button", { name: "Maximize panel", exact: true })
    .click();
  await page.waitForTimeout(600);
  await editor.focus();
  await page.waitForTimeout(220);
  assert.equal(
    await editor.evaluate(
      (e: HTMLElement) => e === (window as any).__originalEditor
    ),
    true
  );
  await handle.focus();
  await handle.press("Enter");
  await reveal.focus();
  await reveal.press("Enter");
  await page.waitForTimeout(200);
  assert.equal(
    await editor.evaluate((e: HTMLElement) => document.activeElement === e),
    true
  );
  await page
    .getByRole("button", { name: "Restore panel", exact: true })
    .click();
  await page.waitForTimeout(600);
  assert.equal(
    await editor.evaluate(
      (e: HTMLElement) => e === (window as any).__originalEditor
    ),
    true
  );
  assert.equal(
    await page
      .locator("webview")
      .filter({ visible: true })
      .first()
      .evaluate((g: any) => g.getWebContentsId()),
    backing
  );
  await editor.focus();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' appended');
  await page.keyboard.press('Meta+z');
  assert.equal(await editor.innerText(), 'Stable native draft', 'undo survives presentation relocation');
  assert.deepEqual(errors, []);
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        passed: true,
        nativeBottomTracking: true,
        stableEditor: true,
        stableBacking: true,
        errors,
      },
      null,
      2
    )
  );
  console.log("Floating composer native smoke passed: " + root);
} finally {
  await app.close();
  server.close();
}
