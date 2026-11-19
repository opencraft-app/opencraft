import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { navigationLifecycleFixture } from "../fixtures/navigation-lifecycle";

const root = process.cwd(),
  output = resolve(process.env.OPENCRAFT_AVATAR_OUTPUT ?? ".local/channel-identity-avatar");
const setup = `import{IdentityAvatarContext}from'@opencraft/extension-react';
window.avatarLookups=[];
window.fixtureMembers=[{actorId:'owner',displayName:'Owner display',actorKind:'human',role:'owner',avatar:{kind:'employee',name:'verified-owner'}},{actorId:'member',displayName:'Member display',actorKind:'human',role:'member',avatar:{kind:'employee',name:'verified-member'}}];
window.fixtureCandidates=[{actorId:'candidate',displayName:'Candidate display',actorKind:'human',avatar:{kind:'employee',name:'verified-candidate'}},{actorId:'broken',displayName:'Broken image',actorKind:'human',avatar:{kind:'employee',name:'missing-photo'}},{actorId:'unverified',displayName:'verified-owner',actorKind:'human'},{actorId:'bot',displayName:'Bot candidate',actorKind:'session'}];
const photoProvider={id:'fixture',resolve(kind,name){window.avatarLookups.push([kind,name]);return '/identity-photo/'+encodeURIComponent(name)+'.svg'}};
`;
let source = setup + navigationLifecycleFixture;
source = source.replace(
  "kind:'group',canSend:true,canManageMembers:false",
  "kind:i===1?'direct':'group',canSend:true,canManageMembers:true,canRename:true,participants:i===1?[window.fixtureMembers[1]]:window.fixtureMembers",
);
source = source.replace(
  "if(method==='opencraft/channels/group/members/list')return{members:[]};",
  "if(method==='opencraft/channels/group/members/list')return{members:window.fixtureMembers};if(method==='opencraft/channels/group/candidates/search')return{candidates:window.fixtureCandidates.filter(actor=>actor.displayName.toLowerCase().includes((p.query||'').toLowerCase()))};",
);
source = source
  .replace(
    "render(<WorkbenchPresentationRootProvider",
    "render(<IdentityAvatarContext.Provider value={photoProvider}><WorkbenchPresentationRootProvider",
  )
  .replace(
    "</WorkbenchPresentationRootProvider>);",
    "</WorkbenchPresentationRootProvider></IdentityAvatarContext.Provider>);",
  );
assert.ok(source.includes("participants:i===1?"));
const server = await createServer({
  root,
  configFile: false,
  publicDir: root + "/apps/workbench-web/public",
  logLevel: "error",
  cacheDir: output + "/vite-cache",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react-intl",
      "motion/react",
      "@tanstack/react-query",
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-model",
      "prosemirror-transform",
      "prosemirror-commands",
      "prosemirror-history",
      "prosemirror-keymap",
      "prosemirror-schema-list",
      "prosemirror-inputrules",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "tslib",
    ],
  },
  plugins: [
    {
      name: "channel-avatar-fixture",
      resolveId: (id) => (id === "/avatar-fixture.tsx" ? id : null),
      load: (id) => (id === "/avatar-fixture.tsx" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/identity-photo/")) {
            if (req.url.includes("missing-photo")) {
              res.writeHead(404).end();
              return;
            }
            const color = req.url.includes("owner") ? "#a6bdc9" : req.url.includes("member") ? "#bab0c5" : "#a8bda9";
            res.setHeader("content-type", "image/svg+xml");
            res.end(
              `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><circle cx="32" cy="23" r="12" fill="#eef1f3"/><ellipse cx="32" cy="61" rx="22" ry="22" fill="#eef1f3"/></svg>`,
            );
            return;
          }
          if (!req.headers.accept?.includes("text/html")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/avatar-fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const touch of [false, true])
    for (const theme of ["light", "dark"]) {
      console.log(JSON.stringify({ touch, theme, stage: "start" }));
      const context = await browser.newContext({
          viewport: { width: touch ? 390 : 1280, height: 900 },
          hasTouch: touch,
          isMobile: touch,
        }),
        page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        (window as any).__name = (x: unknown) => x;
      });
      await page.goto(server.resolvedUrls!.local[0]! + "?theme=" + theme);
      await page.getByRole("button", { name: "Open Inbox", exact: true }).click();
      await page
        .getByRole("button", { name: /Navigation group 0\b/ })
        .first()
        .click();
      const live = page.locator(".page-stack > .page-stack__live"),
        editor = live.locator("[contenteditable=true]").first();
      await editor.waitFor();
      const portraits = async (selector: string, count: number) => {
        await page.waitForFunction(
          ({ selector, count }) => {
            const nodes = [...document.querySelectorAll<HTMLImageElement>(selector)];
            return nodes.length === count && nodes.every((n) => n.complete && n.naturalWidth > 0);
          },
          { selector, count },
        );
      };
      await portraits(".page-stack > .page-stack__live .im-channel-chat__heading img", 2);
      await page.waitForFunction(() => {
        const live = document.querySelector<HTMLElement>(".page-stack > .page-stack__live");
        return live && !live.inert && !live.style.transform;
      });
      const headerBefore = await live.locator(".im-channel-chat__group-avatar").boundingBox();
      assert.ok(
        headerBefore && Math.abs(headerBefore.width - 32) < 0.1 && Math.abs(headerBefore.height - 32) < 0.1,
        JSON.stringify(headerBefore),
      );
      await page.waitForFunction(() => {
        const live = document.querySelector<HTMLElement>(".page-stack > .page-stack__live");
        return live && !live.inert && !live.style.transform;
      });
      await editor.click();
      await editor.pressSequentially("Unsent text stays here");
      assert.equal(await editor.innerText(), "Unsent text stays here");
      await live.getByRole("button", { name: "Group settings", exact: true }).click();
      const dialog = page.getByRole("dialog").last();
      await portraits(".im-member-grid img", 2);
      await page.screenshot({ path: output + `/${touch ? "touch" : "desktop"}-${theme}-grid.png` });
      await dialog.getByRole("button", { name: /View all members/ }).click();
      await portraits(".im-channel-group-dialog__members img", 2);
      await page.screenshot({ path: output + `/${touch ? "touch" : "desktop"}-${theme}-members.png` });
      await dialog.getByRole("button", { name: "Back", exact: true }).click();
      await dialog.getByRole("button", { name: "Add members", exact: true }).click();
      const candidate = dialog.locator(".im-channel-group-dialog__choice").filter({ hasText: "Candidate display" });
      await portraits('.im-channel-group-dialog__choice:has(input) img[src*="verified-candidate"]', 1);
      await page.waitForFunction(
        () => document.querySelector(".im-channel-group-dialog__choice:has(input) .im-channel-chat__person") !== null,
      );
      const broken = dialog.locator(".im-channel-group-dialog__choice").filter({ hasText: "Broken image" });
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".im-channel-group-dialog__choice")].some(
          (n) => n.textContent?.includes("Broken image") && !n.querySelector("img"),
        ),
      );
      assert.equal(await broken.locator(".im-channel-chat__person").innerText(), "B");
      assert.equal(
        await dialog
          .locator(".im-channel-group-dialog__choice")
          .filter({ hasText: "verified-owner" })
          .locator("img")
          .count(),
        0,
        "a display name is not a photo key",
      );
      await candidate.getByRole("checkbox").check();
      await portraits(".im-channel-group-dialog__selection img", 1);
      await page.screenshot({ path: output + `/${touch ? "touch" : "desktop"}-${theme}-add.png` });
      await dialog.getByRole("button", { name: "Back", exact: true }).click();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      assert.equal(await editor.innerText(), "Unsent text stays here");
      assert.deepEqual(await live.locator(".im-channel-chat__group-avatar").boundingBox(), headerBefore);
      await page.evaluate(() =>
        (window as any).navigationProbe.openExtensionView("opencraft.im.channel-chat", "opencraft-channel:g1"),
      );
      await portraits(".page-stack > .page-stack__live .im-channel-chat__heading img", 1);
      assert.ok(
        (await live.locator(".im-channel-chat__heading img").getAttribute("src"))?.includes("verified-member"),
        "cold direct header uses its peer, not history",
      );
      const lookups = await page.evaluate(() => (window as any).avatarLookups);
      assert.ok(
        lookups.every(
          ([kind, name]: string[]) =>
            kind === "employee" &&
            ["verified-owner", "verified-member", "verified-candidate", "missing-photo"].includes(name!),
        ),
      );
      assert.deepEqual(errors, []);
      results.push({
        touch,
        theme,
        headerBeforeHistory: true,
        memberGrid: true,
        memberList: true,
        candidateAndSelection: true,
        failedAndUnknownFallback: true,
        draftAndGeometryPreserved: true,
        coldDirectPeer: true,
      });
      await context.close();
    }
  await writeFile(output + "/evidence.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await browser?.close();
  await server.close();
}
