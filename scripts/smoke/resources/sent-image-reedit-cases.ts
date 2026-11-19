import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { Browser } from "playwright";

export async function verifySentImageReedit(browser: Browser, url: string) {
  const output = process.env.OPENCRAFT_IMAGE_REEDIT_OUTPUT ?? "/tmp/opencraft-image-reedit";
  await mkdir(output, { recursive: true });
  for (const touch of [false, true]) for (const mode of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1200, height: 800 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`${url}?gallery&mode=${mode}${touch ? "&touch" : ""}`);
    const activate = async (locator: ReturnType<typeof page.locator>) => touch ? locator.tap() : locator.click();
    const draft = () => page.evaluate(() => (window as any).imagePreviewFixture.controller.getSnapshot().draft);
    await page.locator('.ProseMirror').fill("Keep this draft");
    const chooser = page.waitForEvent("filechooser");
    await activate(page.getByRole("button", { name: "Add", exact: true }));
    await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("keep attachment") });
    const before = await draft();
    const thumbnails = page.getByRole("button", { name: "Open attached image", exact: true });
    const originalSource = await thumbnails.nth(1).locator("img").getAttribute("src");
    await activate(thumbnails.nth(1));
    const edit = page.getByRole("button", { name: "Edit image", exact: true });
    await page.screenshot({ path: `${output}/preview-${touch}-${mode}.png` });
    await activate(edit);
    const canvas = page.getByLabel("Image editing canvas", { exact: true });
    await canvas.waitFor();
    await activate(page.getByRole("button", { name: "Crop", exact: true }));
    await activate(page.getByRole("button", { name: "Rotate clockwise", exact: true }));
    await activate(page.getByRole("button", { name: "Cancel", exact: true }));
    await page.getByRole("dialog", { name: "Attached image 2 of 3", exact: true }).waitFor();
    assert.deepEqual(await draft(), before, "cancel keeps the complete draft");
    await activate(edit); await canvas.waitFor();
    await activate(page.getByRole("button", { name: "Crop", exact: true }));
    await activate(page.getByRole("button", { name: "Rotate clockwise", exact: true }));
    await page.screenshot({ path: `${output}/editor-${touch}-${mode}.png` });
    await activate(page.getByRole("button", { name: "Done", exact: true }));
    await page.locator('.image-editor').waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 0, "done returns directly to composer");
    const after = await draft();
    assert.deepEqual(after.document, before.document);
    assert.deepEqual(after.attachments[0], before.attachments[0]);
    assert.equal(after.attachments.length, 2);
    await page.waitForFunction(() => {
      const root = document.querySelector('#host')!.shadowRoot!;
      return root.activeElement?.classList.contains('ProseMirror');
    });
    const result = await page.evaluate(async () => {
      const fixture = (window as any).imagePreviewFixture;
      const file = fixture.files.at(-1), bitmap = await createImageBitmap(file);
      const result = { type: file.type, width: bitmap.width, height: bitmap.height, submissions: fixture.submissions };
      bitmap.close(); return result;
    });
    assert.deepEqual(result, { type: "image/png", width: 500, height: 800, submissions: 0 });
    assert.equal(await thumbnails.nth(1).locator('img').getAttribute('src'), originalSource);
    await page.screenshot({ path: `${output}/draft-${touch}-${mode}.png` });
    // Reopen starts a fresh editor; a late result cannot enter another draft.
    await activate(thumbnails.nth(1)); await activate(edit); await canvas.waitFor();
    await activate(page.getByRole("button", { name: "Crop", exact: true }));
    await activate(page.getByRole("button", { name: "Rotate clockwise", exact: true }));
    await page.evaluate(() => (window as any).imagePreviewFixture.switchThread("other"));
    await activate(page.getByRole("button", { name: "Done", exact: true }));
    await page.getByRole("alert").waitFor();
    assert.equal((await draft()).attachments.length, 0);
    await activate(page.getByRole("button", { name: "Cancel", exact: true }));
    assert.deepEqual(errors, []);
    await context.close();
    console.log("PASS sent image re-edit", touch ? "touch" : "mouse", mode);
  }
}
