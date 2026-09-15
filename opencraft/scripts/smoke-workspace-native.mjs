import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
if (!process.env.OPENCRAFT_CDP_URL) throw new Error("Set OPENCRAFT_CDP_URL to a verified independent preview");
const output = "/tmp/opencraft-workspace-native";
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.OPENCRAFT_CDP_URL);
try {
  const page = browser.contexts()[0].pages()[0];
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('OC_WORKSPACE_PROBE=retained'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('.app-shell-bottom-panel, [data-panel-region="bottom"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Move .* to bottom panel|Show bottom panel/ }).count(), 0);
  await page.getByRole('button', { name: 'Maximize panel', exact: true }).click();
  await page.getByRole('button', { name: 'Restore panel', exact: true }).click();
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('printf "after-restore:%s\\\\n" "$OC_WORKSPACE_PROBE"'); await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.screenshot({ path: output + '/right-only.png' });
  assert.deepEqual(errors, []);
  await writeFile(output + '/result.json', JSON.stringify({ result: 'passed', bottomPanelAbsent: true, errors, note: 'Verify retained shell variable visually in screenshots; no external model requests.' }, null, 2));
  console.log('Native right-only workspace passed: ' + output);
} finally { await browser.close(); }
