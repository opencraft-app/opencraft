import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { ActorStore } from "@opencraft/access-control/actors";
import { InstanceAccess, MembershipStore } from "@opencraft/access-control";
import { ActorSshKeys, installationSshKeyAuthority } from "../../../apps/headless-server/src/actor-ssh-keys.ts";
import { actorSshKeysHttp } from "../../../apps/headless-server/src/actor-ssh-keys-http.ts";
import { humanActorAccess } from "../../../apps/headless-server/src/account-model-defaults-http.ts";
import { generateEd25519KeyPair } from "../../../tests/support/ssh-ed25519.mjs";
import { serveNodeHttpExchange } from "@opencraft/http-exchange/node";

// The real Settings page, locale, server-scoped fetch, HTTP route, network-thread
// projection and Server owner Worker. Only the sign-in is synthetic: every request
// is the fixture person. No production data, keys or SSH listener are involved.
const directory = await mkdtemp(join(tmpdir(), "ssh-keys-browser-"));
const artifacts = process.env.OPENCRAFT_SSH_KEYS_ARTIFACTS ?? join(directory, "screenshots");
await mkdir(artifacts, { recursive: true });
const storage = await openServerCoreOwner(join(directory, "server"));
const actors = new ActorStore(storage),
  members = new MembershipStore(storage),
  access = new InstanceAccess(members, [], actors);
const keys = await ActorSshKeys.open(storage.call, installationSshKeyAuthority({ actors, access }));
let signedIn = true,
  sshLogin = false;
const person = actors.resolveHuman({
  provider: "local",
  subject: "fixture",
  displayName: "Fixture",
  expiresAt: Date.now() + 3_600_000,
});
members.setActor(person.actorId, "member", true, "fixture");
const other = actors.resolveHuman({
  provider: "local",
  subject: "other",
  displayName: "Other",
  expiresAt: Date.now() + 3_600_000,
});
members.setActor(other.actorId, "member", true, "fixture");
const handler = () =>
  actorSshKeysHttp(keys, {
    access: humanActorAccess({
      authenticate: () => (signedIn ? { ...person, expiresAt: Date.now() + 60_000 } : null),
      isCurrentHuman: (context) => actors.isCurrent(context),
      admits: (actorId) => access.admitsActor(actorId),
      trustedOrigin: () => null,
    }),
    administrator: () => false,
    isHuman: (actorId) => actors.get(actorId)?.kind === "human",
    sshLogin,
  });
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  cacheDir: join(directory, "vite-cache"),
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "ssh-keys-fixture",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/servers/fixture/__opencraft_ssh_keys")) {
            req.url = req.url.slice("/servers/fixture".length);
            void serveNodeHttpExchange(req, res, handler());
            return;
          }
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script id="opencraft-server-context" type="application/json">{"id":"fixture","name":"Fixture server","basePath":"/servers/fixture","selectorPath":"/servers"}</script><script type="module" src="/tests/fixtures/ssh-keys.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const taken = generateEd25519KeyPair().public;
  await keys.add(other.actorId, { name: "Other device", publicKey: taken }, "fixture");
  for (const touch of [false, true])
    for (const theme of ["light", "dark"]) {
      const locale = touch ? "zh-CN" : "en-US",
        name = `${touch ? "touch-390" : "pointer-1280"}-${theme}`,
        t = touch;
      sshLogin = theme === "dark";
      signedIn = true;
      for (const key of keys.list(person.actorId)) await keys.remove(person.actorId, key.id, "fixture");
      const context = await browser.newContext({
        viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
      });
      await page.addInitScript("window.__name = value => value");
      const press = (locator) => (t ? locator.tap() : locator.click());
      await page.goto(origin + "/?locale=" + locale + "&theme=" + theme);
      await page
        .getByText(t ? "还没有 SSH 密钥" : "No SSH keys yet")
        .waitFor({ timeout: 8000 })
        .catch(async (error) => {
          console.error(errors, await page.evaluate(() => document.body.innerText));
          throw error;
        });
      assert.equal(
        await page
          .getByText(t ? "此服务器尚未接受 SSH 连接" : "This server does not accept SSH connections yet", {
            exact: false,
          })
          .count(),
        sshLogin ? 0 : 1,
      );
      const field = page.getByRole("textbox", { name: t ? "公钥" : "Public key", exact: true });
      const nameField = page.getByRole("textbox", { name: t ? "名称" : "Name", exact: true });
      const submit = page.getByRole("button", { name: t ? "添加密钥" : "Add key", exact: true });
      assert.equal(await submit.isDisabled(), true);
      // A refused key keeps the draft and reports in the reserved slot without moving the action.
      const offset = async () => (await submit.boundingBox()).y - (await field.boundingBox()).y;
      const before = await offset();
      await field.fill("not a key");
      await press(submit);
      await page
        .getByRole("alert")
        .filter({ hasText: t ? "OpenSSH 公钥" : "OpenSSH public key" })
        .waitFor();
      assert.equal(await offset(), before, "the validation slot is reserved");
      assert.equal(await field.inputValue(), "not a key");
      await field.fill(taken);
      await press(submit);
      await page
        .getByRole("alert")
        .filter({ hasText: t ? "属于此服务器上的其他人" : "belongs to another person" })
        .waitFor();
      const mine = generateEd25519KeyPair().public;
      await field.fill(mine + " me@laptop");
      await nameField.fill(t ? "工作笔记本" : "Work laptop");
      await press(submit);
      await page.getByText(t ? "工作笔记本" : "Work laptop", { exact: true }).waitFor();
      assert.equal(await field.inputValue(), "");
      assert.equal(await nameField.inputValue(), "");
      await field.fill(generateEd25519KeyPair().public + " second@desk");
      await press(submit);
      await page.getByText("second@desk", { exact: true }).waitFor();
      assert.equal(keys.list(person.actorId).length, 2, "both keys committed through the owner Worker");
      await page.screenshot({ path: join(artifacts, name + ".png"), fullPage: true });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        "no horizontal overflow",
      );
      await press(page.getByRole("button", { name: t ? "移除 工作笔记本" : "Remove Work laptop", exact: true }));
      await page.getByText(t ? "工作笔记本" : "Work laptop", { exact: true }).waitFor({ state: "detached" });
      assert.deepEqual(
        keys.list(person.actorId).map((key) => key.name),
        ["second@desk"],
      );
      await page.reload();
      await page.getByText("second@desk", { exact: true }).waitFor();
      signedIn = false;
      await field.fill(generateEd25519KeyPair().public);
      await press(submit);
      await page
        .getByRole("alert")
        .filter({ hasText: t ? "重新登录" : "Sign in again" })
        .waitFor();
      assert.deepEqual(errors, []);
      await context.close();
    }
  console.log(
    "PASS pointer 1280 and touch 390, light and dark: real route, owner Worker commits, refusal slot, duplicate across people, add/remove/reload, session expiry and no horizontal overflow. Artifacts: " +
      artifacts,
  );
} finally {
  await browser?.close();
  await server.close();
  keys.close();
  members.close();
  actors.close();
  await storage.close();
  if (!process.env.OPENCRAFT_SSH_KEYS_ARTIFACTS) await rm(directory, { recursive: true, force: true });
}
