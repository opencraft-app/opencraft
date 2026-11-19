import fs from "node:fs";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = process.cwd(),
  task = process.env.OPENCRAFT_MENTIONS_OUTPUT ?? root + "/.local/native-mentions-evidence/";
fs.mkdirSync(task, { recursive: true });
const { createServer } = await import(pathToFileURL(root + "/node_modules/vite/dist/node/index.js")),
  { chromium } = await import(pathToFileURL(root + "/node_modules/playwright/index.mjs"));
const server = await createServer({
  root,
  configFile: false,
  cacheDir: task + "vite",
  publicDir: root + "/apps/workbench-web/public",
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: {
    include: [
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-model",
      "prosemirror-transform",
      "prosemirror-commands",
      "prosemirror-history",
      "prosemirror-keymap",
      "prosemirror-inputrules",
      "prosemirror-schema-list",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "motion/react",
      "@tanstack/react-query",
      "react-intl",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-alert-dialog",
      "tslib",
    ],
  },
  plugins: [
    {
      name: "navigation-probe",
      resolveId: (id) => (id === "/navigation-probe.tsx" ? id : null),
      load: (id) =>
        id === "/navigation-probe.tsx"
          ? fs.readFileSync(root + "/tests/fixtures/native-mentions-app.tsx", "utf8")
          : null,
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (
            req.url?.startsWith("/@") ||
            req.url?.startsWith("/node_modules") ||
            req.url?.startsWith("/apps/") ||
            req.url?.startsWith("/packages/") ||
            req.url?.startsWith("/plugins/") ||
            req.url?.startsWith("/navigation-probe.tsx") ||
            req.url?.startsWith("/products/")
          )
            return next();
          if (req.headers.accept?.includes("text/html")) {
            res.setHeader("content-type", "text/html");
            res.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/navigation-probe.tsx"></script>',
            );
          } else next();
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      "/data/build/cache/playwright/chromium-1248/chrome-linux64/chrome",
  });
  for (const touch of [false, true])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
          viewport: { width: touch ? 390 : 1200, height: 844 },
          hasTouch: touch,
          isMobile: touch,
        }),
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(60000);
      await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/?theme=" + theme);
      await page.getByRole("button", { name: "Open Inbox", exact: true }).click();
      const live = page.locator(".page-stack > .page-stack__live");
      await live.getByText("Mentioned you", { exact: true }).waitFor();
      const enter = live.getByRole("button", {
        name: "Release room",
        exact: true,
      });
      if (touch) await enter.tap();
      else await enter.click();
      const editor = live.locator("[contenteditable=true]").first();
      await editor.waitFor();
      const submit = () =>
        touch ? live.getByRole("button", { name: "Send message", exact: true }).tap() : editor.press("Enter");
      // Latest-page reads do not consume an old mention outside the 50-message snapshot.
      await editor.click();
      await live.locator("[data-message-timeline]").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      });
      await page
        .waitForFunction(() => window.control.reads > 0, {}, { timeout: 15000 })
        .catch(async (e) => {
          await page.screenshot({ path: task + "failure.png" });
          console.log(
            await page.locator("body").innerText(),
            await page.evaluate(() => ({
              focus: document.hasFocus(),
              visibility: document.visibilityState,
              control: window.control,
            })),
            errors,
          );
          throw e;
        });
      assert.deepEqual(await page.evaluate(() => window.control.acks), []);
      await editor.fill("draft before jump");
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const jump = live.getByRole("button", {
        name: "Next unread mention",
        exact: true,
      });
      if (touch) await jump.tap();
      else await jump.click();
      await live.locator(".im-channel-mention[data-self=true]").waitFor();
      assert.ok((await editor.innerText()).includes("draft before jump"));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.control.ackAttempts), 0);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page
        .waitForFunction(() => window.control.ackAttempts === 1, {}, { timeout: 15000 })
        .catch(async (error) => {
          await page.screenshot({ path: task + "ack-failure.png" });
          const debug = await page.evaluate(() => ({
            control: window.control,
            focus: document.hasFocus(),
            targets: [...document.querySelectorAll("[data-unread-mention-message]")].map((el) => ({
              box: el.getBoundingClientRect().toJSON(),
              root: el.closest("[data-message-timeline]")?.getBoundingClientRect().toJSON(),
              id: el.dataset.unreadMentionMessage,
              hidden: !!el.closest('[inert],[hidden],[aria-hidden="true"]'),
            })),
          }));
          console.log(JSON.stringify(debug, null, 2));
          throw error;
        });
      assert.deepEqual(await page.evaluate(() => window.control.acks), []);
      await page.waitForFunction(() => window.control.acks.length === 1);
      assert.deepEqual(await page.evaluate(() => window.control.acks), ["m1"]);
      await jump.waitFor({ state: "hidden" });
      await live
        .locator("strong")
        .filter({ hasText: /^bold$/ })
        .waitFor();
      await editor.fill("");
      await live.locator(".im-channel-mention[data-self=true]").getByText("@Alice", { exact: true }).waitFor();
      if (touch) await editor.tap();
      else await editor.click();
      await editor.pressSequentially("@");
      const picker = page.getByRole("listbox", {
        name: "Mention members",
        exact: true,
      });
      await picker.waitFor();
      await picker.getByRole("option").filter({ hasText: "Bob" }).waitFor();
      await page.screenshot({
        path: task + "picker-" + (touch ? "touch" : "desktop") + "-" + theme + ".png",
      });
      if (touch) await picker.getByRole("option").filter({ hasText: "Bob" }).tap();
      else {
        await editor.pressSequentially("Bob");
        await editor.press("Enter");
      }
      await live
        .getByText("Some mentions stay in this app; the external service has no verified matching account.", {
          exact: true,
        })
        .waitFor();
      await editor.pressSequentially(" please review");
      await submit();
      await page.waitForFunction(() => window.control.sent.length === 1);
      let sent = await page.evaluate(() => window.control.sent[0]);
      assert.deepEqual(sent.mentions, [{ actorId: "bob", start: 0, end: 4 }]);
      assert.equal(sent.wakeActorIds, undefined);
      assert.ok(sent.parts[0].text.includes("@Bob"));
      await live.locator(".im-channel-mention[data-actor-id=bob]").waitFor();
      if (touch) await editor.tap();
      else await editor.click();
      await editor.pressSequentially("@Build");
      await picker.getByRole("option").filter({ hasText: "Build Bot" }).waitFor();
      if (touch) await picker.getByRole("option").filter({ hasText: "Build Bot" }).tap();
      else await editor.press("Enter");
      await editor.pressSequentially(" run tests");
      await submit();
      await page.waitForFunction(() => window.control.sent.length === 2);
      sent = await page.evaluate(() => window.control.sent[1]);
      assert.deepEqual(sent.wakeActorIds, ["bot"]);
      assert.equal(sent.mentions[0].actorId, "bot");
      await editor.pressSequentially("@Quiet");
      await picker.getByRole("option").filter({ hasText: "Quiet Bot" }).waitFor();
      if (touch) await picker.getByRole("option").filter({ hasText: "Quiet Bot" }).tap();
      else await editor.press("Enter");
      await live
        .getByText(
          "This mention refers to a bot but won't start it; you don't currently have wake permission or it is unavailable.",
          { exact: true },
        )
        .waitFor();
      await editor.fill("");
      // Literal unselected text does not gain a human identity.
      await editor.fill("Hi @Bob typed, not selected");
      await editor.press("Escape");
      await submit();
      await page.waitForFunction(() => window.control.sent.length === 3);
      assert.deepEqual((await page.evaluate(() => window.control.sent[2])).mentions, []);
      // A stale member rejection retains the structured draft, rather than silently downgrading it.
      await page.evaluate(() => (window.control.failSend = true));
      await editor.pressSequentially("@Bob");
      await picker.getByRole("option").filter({ hasText: "Bob" }).waitFor();
      await editor.press("Enter");
      await editor.pressSequentially(" retained draft");
      await submit();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.control.sent.length), 3);
      assert.ok((await editor.innerText()).includes("@Bob"));
      assert.ok((await editor.innerText()).includes("retained draft"));
      const density = await page.locator("html").getAttribute("data-ui-density");
      assert.equal(density, touch ? "touch" : "compact");
      await page.screenshot({
        path: task + "messages-" + (touch ? "touch" : "desktop") + "-" + theme + ".png",
      });
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          touch,
          theme,
          density,
          memberPicker: true,
          humanNoWake: true,
          botWake: true,
          selfHighlight: true,
          unreadMarker: true,
          unselectedPlain: true,
          failedDraftRetained: true,
        }),
      );
      await context.close();
    }
} finally {
  await browser?.close();
  await server.close();
}
