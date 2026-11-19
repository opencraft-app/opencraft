import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium, webkit, type Page } from "playwright";
import { PNG } from "pngjs";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/reading-material";
await mkdir(output, { recursive: true });
const original = await readFile("scripts/smoke/shell/smoke-panel-toolbar-ownership.ts", "utf8");
let source = original.split("const source=`")[1]!.split("`;")[0]!;
source = "import {installReadingMaterialFixture} from '/tests/fixtures/reading-material.tsx';\n" + source;
source = source.replace(
  "for(let i=0;i<12;i++)panels.open('scope','terminal',{id:String(i)});",
  `const {Main,side}=await installReadingMaterialFixture(ctx);
// Keep the real side-chat renderer, with an isolated panel owner instead of
// the production side-chat reconciliation service's authoritative tab list.
panels.register({kind:'reading-sidechat',createTab:params=>({...params,kind:'reading-sidechat',region:'right',icon:'chat',closable:true,preview:false})});
panels.open('scope','reading-sidechat',{id:'sidechat:side-preview',resource:'side-preview',title:'Side chat'});`,
);
source = source.replace("renderers={[]}", "renderers={[{...side,kind:'reading-sidechat'}]}");
source = source.replace("<input aria-label='Draft' defaultValue='Keep draft'/>", "<Main/>");
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: "node_modules/.vite-reading-material-" + (process.env.OPENCRAFT_SMOKE_BROWSER ?? "chromium"),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "reading-material",
      transform(code, id) {
        /* This layout fixture has no Host thread catalog. */ if (
          id.split("?")[0]!.endsWith("/panels/side-chat-panel-plugin.tsx")
        )
          return code.replace("const catalog = useThreadCatalog();", "const catalog = { threads: [] };");
      },
      resolveId: (id) => (id === "/reading-fixture.tsx" ? id : null),
      load: (id) => (id === "/reading-fixture.tsx" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/reading-fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
await server.listen();
const browser =
  process.env.OPENCRAFT_SMOKE_BROWSER === "webkit"
    ? await webkit.launch()
    : await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
async function assertReadingContour(page: Page, selector: string, touch: boolean) {
  const scroll = page.locator(selector);
  await scroll.evaluate((node) => {
    node.scrollTop = -300;
    const marker = document.createElement("div");
    marker.id = "reading-fade-probe";
    marker.style.cssText =
      "position:absolute;inset-inline:0;bottom:0;height:5000px;background:magenta;z-index:999;pointer-events:none";
    node.querySelector(".thread-scroll-surface")!.append(marker);
  });
  try {
    const box = (await scroll.boundingBox())!;
    // Assert against the actual editor, not the diagnostic marker itself. The
    // old outer-stack marker included floating file summaries and hid the bug.
    const surface = (await page
      .locator(selector.replace(".thread-scroll", ".opencraft-composer-shell"))
      .boundingBox())!;
    const span = await scroll.evaluate((node) => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;height:var(--height-composer-reading-fade);width:0;pointer-events:none";
      node.append(probe);
      const value = probe.getBoundingClientRect().height;
      probe.remove();
      return value;
    });
    const clips = [3, box.width - 6].flatMap((x) =>
      [1.2, 0.75, 0.5, 0.25, -0.15].map((ratio) => ({
        x: Math.floor(box.x + x),
        y: Math.floor(surface.y - span * ratio),
        width: 3,
        height: 3,
      })),
    );
    const contour = [
      [surface.x + 1, surface.y + 1],
      [surface.x + surface.width - 4, surface.y + 1],
      [surface.x + 1, surface.y + surface.height - 4],
      [surface.x + surface.width - 4, surface.y + surface.height - 4],
      [surface.x + surface.width * 0.5, surface.y + surface.height * 0.5],
      [surface.x + surface.width * 0.5, surface.y + surface.height + 2],
    ].map(([x, y]) => ({ x: Math.floor(x!), y: Math.floor(y!), width: 3, height: 3 }));
    clips.push(...contour);
    const before = [];
    for (const clip of clips) before.push(PNG.sync.read(await page.screenshot({ clip })));
    await page.locator("#reading-fade-probe").evaluate((node) => ((node as HTMLElement).style.background = "lime"));
    const strengths = [];
    for (const [index, clip] of clips.entries()) {
      const after = PNG.sync.read(await page.screenshot({ clip }));
      let delta = 0;
      for (let i = 0; i < after.data.length; i++)
        if (i % 4 !== 3) delta += Math.abs(after.data[i]! - before[index]!.data[i]!);
      strengths.push(delta / (after.width * after.height * 3));
    }
    for (const offset of [0, 5]) {
      const samples = strengths.slice(offset, offset + 5);
      if (touch)
        assert(
          samples.every((value) => value > 100),
          "touch keeps the floating reading gutter",
        );
      else {
        assert(
          samples.every((value) => value > 100),
          "pointer keeps real transcript paint in the exterior gutter too: " + samples,
        );
      }
    }
    const corners = strengths.slice(10, 14),
      interior = strengths[14]!;
    assert(
      corners.slice(0, 2).every((value) => value > 60),
      "upper real rounded corners retain transcript paint: " + corners,
    );
    assert(
      corners.slice(2).every((value) => value < 2),
      "lower rounded corners must not leak transcript paint: " + corners,
    );
    assert(strengths[15]! < 2, "the strip below the editor stays quiet, not a second reading line: " + strengths[15]);
    assert(
      interior < 12,
      "the actual editing surface stays substantially filled rather than using a glass-panel veil: " + interior,
    );
    const crisp = await page
      .locator(selector.replace(".thread-scroll", ".opencraft-composer-editor"))
      .evaluate((node) => {
        const rows = [];
        for (
          let current: HTMLElement | null = node as HTMLElement;
          current && !current.classList.contains("thread-scroll-plane");
          current = current.parentElement
        ) {
          const style = getComputedStyle(current);
          rows.push({
            className: current.className,
            filter: style.filter,
            backdrop: style.backdropFilter,
            mask: style.maskImage,
          });
        }
        return rows;
      });
    for (const row of crisp) {
      assert.equal(row.filter, "none", JSON.stringify(row));
      assert.equal(row.mask, "none", JSON.stringify(row));
      assert.ok(!row.backdrop || row.backdrop === "none", JSON.stringify(row));
    }
    return { strengths, corners, interior, below: strengths[15], crisp };
  } finally {
    await page.locator("#reading-fade-probe").evaluate((node) => node.remove());
  }
}

const results: unknown[] = [];
try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: touch ? 390 : 1600, height: 900 },
      hasTouch: touch,
      isMobile: touch,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    page.on("requestfailed", (request) => console.error(request.url(), request.failure()?.errorText));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(server.resolvedUrls!.local[0]!);
    await page
      .locator(".side-chat-panel .opencraft-composer-editor")
      .waitFor()
      .catch(async (error) => {
        await page.screenshot({ path: `${output}/fixture-failure.png` });
        console.error(await page.locator("body").innerText());
        throw error;
      });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate((touch) => {
      document.documentElement.dataset.uiDensity = touch ? "touch" : "compact";
    }, touch);
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => (window as any).readingMaterial.theme(mode), mode);
      await page.waitForTimeout(250);
      const state = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".thread-scroll-plane")].map((plane) => {
          const scroll = plane.querySelector<HTMLElement>(".thread-scroll")!,
            footer = plane.querySelector<HTMLElement>(".thread-scroll-footer")!;
          return {
            scroll: scroll.getBoundingClientRect().toJSON(),
            footer: footer.getBoundingClientRect().toJSON(),
            height: parseFloat(scroll.style.getPropertyValue("--thread-footer-height")),
            clip: getComputedStyle(scroll).clipPath,
            mask: getComputedStyle(scroll).maskImage,
            overlay: !scroll.contains(footer),
            cover: getComputedStyle(footer, "::after").content,
          };
        }),
      );
      assert.equal(state.length, 2);
      for (const s of state) {
        assert(s.overlay);
        assert.equal(s.cover, "none");
        if (s.scroll.height) {
          assert(Math.abs(s.height - s.footer.height) < 1);
          assert(Math.abs(s.scroll.bottom - s.footer.bottom) < 1);
          assert.ok(s.clip.startsWith("polygon("), "only the bottom strip is geometrically clipped");
          assert.equal(s.mask, "none", "the transcript is never masked to fake a Composer contour");
        }
      }
      const backgrounds = await page.evaluate(() =>
        [".main-content-frame", ".right-panel-view"].map(
          (selector) => getComputedStyle(document.querySelector(selector)!).backgroundColor,
        ),
      );
      assert.equal(backgrounds[0], backgrounds[1], "main and side pane consume the same reading material");
      await page.screenshot({ path: `${output}/${mode}-${touch ? "touch" : "desktop"}.png` });
      results.push({ mode, touch, state, backgrounds });
      const fade = await assertReadingContour(page, ".side-chat-panel .thread-scroll", touch);
      if (!touch) await assertReadingContour(page, ".main-content-frame .thread-scroll", false);
      results.push({ mode, touch, fade });
    }

    if (!touch && !process.argv.includes("--composer-transition")) {
      // Native occupying scrollbars use a smaller client rectangle than the
      // sibling dock's border box. Exercise it even on overlay-scrollbar hosts.
      const gutterProbe = await page.addStyleTag({ content: "/* native gutter probe */" });
      for (const width of [1600, 800, 430]) {
        await page.setViewportSize({ width, height: 900 });
        for (const gutter of ["auto", "stable", "stable both-edges"]) {
          for (const direction of ["ltr"]) {
            await gutterProbe.evaluate((node, css) => {
              node.textContent = css;
            }, `.thread-scroll { scrollbar-gutter:${gutter} !important; direction:${direction}; }`);
            await page.waitForTimeout(160);
            await page.waitForFunction(
              () =>
                [...document.querySelectorAll<HTMLElement>(".thread-scroll-plane")].every((plane) => {
                  const scroll = plane.querySelector<HTMLElement>(".thread-scroll")!;
                  if (!scroll.clientWidth) return true;
                  const content = plane.querySelector<HTMLElement>(".thread-content")!,
                    shell = plane.querySelector<HTMLElement>(".opencraft-composer-shell")!;
                  const c = content.getBoundingClientRect(),
                    s = shell.getBoundingClientRect(),
                    style = getComputedStyle(content);
                  return (
                    Math.abs(s.left - c.left - parseFloat(style.paddingLeft)) < 1 &&
                    Math.abs(s.right - c.right + parseFloat(style.paddingRight)) < 1
                  );
                }),
              undefined,
              { timeout: 5000 },
            );
            const geometry = await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>(".thread-scroll-plane")].map((plane) => {
                const scroll = plane.querySelector<HTMLElement>(".thread-scroll")!;
                const content = plane.querySelector<HTMLElement>(".thread-content")!;
                const shell = plane.querySelector<HTMLElement>(".opencraft-composer-shell")!;
                const c = content.getBoundingClientRect(),
                  s = shell.getBoundingClientRect(),
                  style = getComputedStyle(content);
                return {
                  visible: scroll.clientWidth > 0,
                  scrollbar: scroll.offsetWidth - scroll.clientWidth,
                  left: s.left - c.left - parseFloat(style.paddingLeft),
                  right: s.right - c.right + parseFloat(style.paddingRight),
                };
              }),
            );
            for (const g of geometry)
              if (g.visible) {
                assert(
                  Math.abs(g.left) < 1 && Math.abs(g.right) < 1,
                  `reading and editing share client edges: ${JSON.stringify({ width, gutter, direction, ...g })}`,
                );
                if (gutter === "stable") assert(g.scrollbar > 0, "test really reserves native scrollbar space");
              }
            results.push({ width, gutter, direction, geometry });
            if (width === 800 && gutter === "stable") {
              await page.locator(".main-content-frame .thread-scroll").evaluate((node) => (node.scrollTop = -300));
              await page.waitForTimeout(100);
              await page.screenshot({ path: `${output}/native-scrollbar-alignment.png` });
            }
          }
        }
      }
      await gutterProbe.evaluate((node) => node.remove());
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.waitForTimeout(200);
    }
    if (touch) {
      await page.evaluate(() =>
        (window as any).fixture.panels.dispatch("scope", { type: "select-foreground", foreground: "primary" }),
      );
      const editor = page.locator(".main-content-frame .opencraft-composer-editor");
      await editor.tap();
      await editor.fill("Touch draft");
      await page.screenshot({ path: `${output}/touch-main.png` });
      assert.equal(await editor.innerText(), "Touch draft");
    }
    if (!touch) {
      const editor = page.locator(".main-content-frame .opencraft-composer-editor");
      await editor.fill("Draft preserved\n".repeat(7));
      await page.waitForTimeout(150);
      const identity = await editor.evaluate((node) => {
        (window as any).originalReadingEditor = node;
        return true;
      });
      assert(identity);
      for (const selector of [".main-content-frame .thread-scroll", ".side-chat-panel .thread-scroll"]) {
        const scroll = page.locator(selector);
        await scroll.evaluate((node) => (node.scrollTop = -600));
        await page.waitForTimeout(80);
        const footer = page.locator(selector.replace(".thread-scroll", ".thread-scroll-footer"));
        const before = await footer.boundingBox();
        await scroll.evaluate((node) => (node.scrollTop = -1200));
        await page.waitForTimeout(80);
        assert.deepEqual(await footer.boundingBox(), before, "dock does not travel with transcript");
        const measured = await scroll.evaluate((node) => ({
          clip: getComputedStyle(node).clipPath,
          height: parseFloat((node as HTMLElement).style.getPropertyValue("--thread-composer-occlusion-height")),
        }));
        const surface = (await page
          .locator(selector.replace(".thread-scroll", ".opencraft-composer-shell"))
          .boundingBox())!;
        assert.ok(measured.clip.startsWith("polygon("));
        assert(
          Math.abs(measured.height - (before!.y + before!.height - surface.y)) < 1,
          "occlusion geometry follows the editing surface, including a multiline draft",
        );
      }
      const anchor = () =>
        page.locator(".main-content-frame .thread-scroll").evaluate((node) => ({
          surface: parseFloat((node as HTMLElement).style.getPropertyValue("--thread-composer-occlusion-height")),
          footer: parseFloat((node as HTMLElement).style.getPropertyValue("--thread-footer-height")),
        }));
      await page.evaluate(() => (window as any).readingMaterial.theme("light", true));
      await page.waitForTimeout(150);
      const beforePill = await anchor();
      await page.screenshot({ path: `${output}/desktop-no-files-state.png` });
      await page.evaluate(() => (window as any).readingMaterial.changes(true));
      await page.locator(".thread-live-changes").waitFor();
      await page.waitForTimeout(150);
      const afterPill = await anchor();
      await page.screenshot({ path: `${output}/desktop-files-state.png` });
      assert(afterPill.footer > beforePill.footer, "the real file-change pill adds footer height");
      assert(
        Math.abs(afterPill.surface - beforePill.surface) < 1,
        "floating file changes never raise the editing surface",
      );
      await assertReadingContour(page, ".main-content-frame .thread-scroll", false);
      await page.evaluate(() => (window as any).readingMaterial.queue(true));
      await page.locator(".main-content-frame .opencraft-composer-queue-item").waitFor();
      await page.waitForTimeout(150);
      const attached = await page.locator(".main-content-frame .thread-scroll-plane").evaluate((plane) => {
        const footer = plane.querySelector<HTMLElement>(".thread-scroll-footer")!.getBoundingClientRect();
        const rail = plane.querySelector<HTMLElement>(".opencraft-composer-attached-rail")!.getBoundingClientRect();
        const scroll = plane.querySelector<HTMLElement>(".thread-scroll")!;
        return {
          expected: footer.bottom - rail.top,
          actual: parseFloat(scroll.style.getPropertyValue("--thread-composer-occlusion-height")),
        };
      });
      assert(
        Math.abs(attached.actual - attached.expected) < 1,
        "a real attached queue still owns the reading occlusion, unlike floating summaries",
      );
      await page.evaluate(() => (window as any).readingMaterial.queue(false));
      await page.locator(".main-content-frame .opencraft-composer-queue-item").waitFor({ state: "detached" });
      // React's lazy queue and ResizeObserver commit asynchronously on cold starts.
      // Wait for the real paint projection, not an assumed 150ms delivery window.
      await page.waitForFunction(
        (expected) => {
          const scroll = document.querySelector<HTMLElement>(".main-content-frame .thread-scroll")!;
          return (
            Math.abs(parseFloat(scroll.style.getPropertyValue("--thread-composer-occlusion-height")) - expected) < 1
          );
        },
        beforePill.surface,
        { timeout: 5000 },
      );
      const afterQueue = await anchor();
      if (Math.abs(afterQueue.surface - beforePill.surface) >= 1) {
        const geometry = await page.locator(".main-content-frame .thread-scroll-plane").evaluate((plane) => ({
          surfaces: [...plane.querySelectorAll<HTMLElement>("[data-composer-occlusion-surface]")].map((node) => ({
            html: node.outerHTML,
            rect: node.getBoundingClientRect().toJSON(),
            display: getComputedStyle(node).display,
          })),
          animations: plane
            .getAnimations({ subtree: true })
            .map((animation) => ({ state: animation.playState, time: animation.currentTime })),
        }));
        await writeFile(
          `${output}/queue-transition-failure.json`,
          JSON.stringify({ beforePill, afterPill, attached, afterQueue, geometry }, null, 2),
        );
      }
      assert(
        Math.abs(afterQueue.surface - beforePill.surface) < 1,
        "removing the queue restores the editor-only geometry: " + JSON.stringify({ beforePill, afterQueue }),
      );
      await page.evaluate(() => {
        (window as any).readingMaterial.theme("light", true);
      });
      assert(await editor.evaluate((node) => node === (window as any).originalReadingEditor));
      assert.match(await editor.innerText(), /Draft preserved/);
      await page.evaluate(() => {
        (window as any).readingMaterial.theme("light");
        const p = (window as any).fixture.panels;
        const tab = p.getOwnerSnapshot("scope").right.tabs[0];
        p.close("scope", tab.region, tab.id);
      });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${output}/empty-pane.png` });
      await page.evaluate(() => {
        (window as any).readingMaterial.theme("light", true);
        (window as any).fixture.panels.dispatch("scope", { type: "set-region-open", region: "right", open: false });
      });
      await page.waitForTimeout(200);
      await page.locator(".main-content-frame .opencraft-composer-editor").fill("");
      await page.locator(".main-content-frame .thread-scroll").evaluate((node) => (node.scrollTop = -420));
      await page.screenshot({ path: `${output}/desktop-fade-with-files.png` });
      await page.screenshot({
        path: `${output}/desktop-fade-detail.png`,
        clip: { x: 0, y: 580, width: 1600, height: 320 },
      });
    }
    await page.emulateMedia({ forcedColors: "active" });
    const accessible = await page.locator(".opencraft-composer-shell").evaluateAll((nodes) =>
      nodes.map((node) => {
        const probe = document.createElement("div");
        probe.style.background = "var(--color-background-elevated-primary-opaque)";
        node.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          filter: getComputedStyle(node, "::before").backdropFilter,
          surface: getComputedStyle(node, "::before").backgroundColor,
          expected,
        };
      }),
    );
    for (const surface of accessible) {
      assert.equal(surface.filter, "none", "forced colors never depend on a translucent filter");
      assert.equal(surface.surface, surface.expected, "forced colors use the actual opaque theme paint");
    }
    results.push({ touch, accessible });
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(`${output}/report.json`, JSON.stringify(results, null, 2));
  console.log("Reading material and dock geometry passed");
} finally {
  await browser.close();
  await server.close();
}
