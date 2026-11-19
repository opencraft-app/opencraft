import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Uses the workspace smoke's real AppShell, RightPanel, composer and iframe.
export async function verifyPaneMotion(browser: any, url: string, output: string) {
  const receipts = [];
  for (const reducedMotion of ["no-preference", "reduce"]) {
    for (const touch of [false, true]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        hasTouch: touch,
        reducedMotion,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.addInitScript("window.__name=value=>value");
      await page.goto(url + "?page-presentation=1", { timeout: 120000 });
      await page.waitForFunction(() => Boolean((window as any).fixture));
      await page.waitForTimeout(700);
      await page.locator('[contenteditable="true"]:visible').fill("Draft survives pane resizing");
      await page.evaluate(() => {
        const f = (window as any).fixture;
        f.setAppearanceThemeId("opencraft.core.see");
        (window as any).originalEditor = document.querySelector('[contenteditable="true"]');
      });
      const activate = async (name: string) => {
        const button = page.getByRole("button", { name, exact: true });
        if (touch) await button.tap();
        else {
          await button.focus();
          await page.keyboard.press("Enter");
        }
      };
      const measure = async (name: string, action: () => Promise<void>) => {
        await page.evaluate(() => {
          const host = window as any;
          host.paneSamples = [];
          host.recordPane = true;
          const sample = () => {
            const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect();
            const pane = rect(".app-shell-right-panel"),
              content = rect(".app-shell-right-panel__surface");
            host.paneSamples.push({
              pane: pane.width,
              content: content.width,
              right: pane.right,
              contentRight: content.right,
            });
            if (host.recordPane) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        await action();
        await page.waitForTimeout(650);
        const samples = await page.evaluate(() => {
          (window as any).recordPane = false;
          return (window as any).paneSamples;
        });
        assert.ok(samples.length > 2);
        for (const sample of samples) {
          assert.ok(
            Math.abs(sample.pane - sample.content) < 2,
            name + ": content jumped ahead of pane " + JSON.stringify(sample),
          );
          assert.ok(Math.abs(sample.right - sample.contentRight) < 2, name + ": content right edge leaves pane");
        }
        const widths = samples.map((s: any) => s.pane);
        if (name !== "reverse") {
          const min = Math.min(widths[0], widths.at(-1)),
            max = Math.max(widths[0], widths.at(-1));
          assert.ok(
            widths.every((w: number) => w >= min - 2 && w <= max + 2),
            name + ": overshoot",
          );
          if (reducedMotion === "no-preference")
            assert.ok(
              widths.some((w: number) => w > min + 10 && w < max - 10),
              name + ": missing intermediate frames",
            );
          else
            assert.ok(
              widths.every((w: number) => Math.abs(w - min) < 2 || Math.abs(w - max) < 2),
              name + ": reduced motion has intermediate frames",
            );
        }
        receipts.push({ name, touch, reducedMotion, samples });
      };
      await measure("maximize", () => activate("Maximize panel"));
      await measure("restore", () => activate("Restore panel"));
      await measure("reverse", async () => {
        await activate("Maximize panel");
        await page.waitForTimeout(65);
        await activate("Restore panel");
      });
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[contenteditable="true"]') === (window as any).originalEditor,
        ),
        true,
      );
      assert.match(await page.locator('[contenteditable="true"]:visible').innerText(), /Draft survives pane resizing/);
      // Empty launcher must use the same reading material as the main pane.
      await page.evaluate(() => {
        const f = (window as any).fixture;
        f.panels.close("scope", "right", "terminal:one");
      });
      await page.waitForTimeout(600);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => (window as any).fixture.setThemePreference(theme), theme);
        await page.waitForTimeout(100);
        const colors = await page.evaluate(() =>
          [".main-content-frame", ".right-panel-view"].map(
            (s) => getComputedStyle(document.querySelector(s)!).backgroundColor,
          ),
        );
        assert.equal(colors[0], colors[1], "preview shares the reading material");
        await page.screenshot({ path: output + "/pane-" + theme + "-" + touch + "-" + reducedMotion + ".png" });
      }
      if (!touch && reducedMotion === "no-preference") {
        await activate("Maximize panel");
        await page.waitForTimeout(60);
        await page.screenshot({ path: output + "/pane-expanding.png" });
        await page.waitForTimeout(400);
        await page.screenshot({ path: output + "/pane-expanded.png" });
        await activate("Restore panel");
        await page.waitForTimeout(60);
        await page.screenshot({ path: output + "/pane-restoring.png" });
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  await writeFile(output + "/pane-motion.json", JSON.stringify(receipts, null, 2));
  console.log(
    "Pane motion passed: live content width, reversal, no overshoot, keyboard/touch, draft identity, reduced motion and See reading material. " +
      output,
  );
}
