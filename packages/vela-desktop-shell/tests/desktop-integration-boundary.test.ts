import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function readFiles(paths: string[]) {
  return paths
    .map((path) => `// ${path}\n${readFileSync(join(root, path), "utf8")}`)
    .join("\n");
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listSourceFiles(path) : [path];
  });
}

test("desktop integration is split into host, shell, controller, and chat renderer packages", () => {
  const expectedPaths = [
    "apps/vela-desktop-electron/README.md",
    "apps/vela-desktop-electron/electron/main.ts",
    "apps/vela-desktop-electron/electron/preload.ts",
    "apps/vela-desktop-electron/src/DesktopApp.tsx",
    "packages/vela-chat-controller/README.md",
    "packages/vela-chat-controller/src/useVelaChatSession.ts",
    "packages/vela-desktop-shell/README.md",
    "packages/vela-desktop-shell/src/VelaDesktopShell.tsx",
    "packages/vela-desktop-shell/src/components/session/SessionSidebar.tsx",
    "packages/vela-desktop-shell/src/components/sidebar/VelaSidebarShell.tsx",
  ];

  for (const path of expectedPaths) {
    assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
  }
});

test("desktop shell owns only reusable chrome and does not talk to velad or chat state", () => {
  const shellSource = readFiles(
    listSourceFiles(join(root, "packages/vela-desktop-shell/src"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );

  assert.match(shellSource, /DesktopHostBridge/);
  assert.match(shellSource, /SessionSidebar/);
  assert.match(shellSource, /VelaSidebarShell/);
  assert.doesNotMatch(shellSource, /createVeladClient/);
  assert.doesNotMatch(shellSource, /useVelaChatSession/);
  assert.doesNotMatch(shellSource, /ChatSurface/);
  assert.doesNotMatch(shellSource, /EventSource/);
  assert.doesNotMatch(shellSource, /\/api\/v1/);
  assert.doesNotMatch(shellSource, /electron/);
  assert.doesNotMatch(shellSource, /tauri/i);
});

test("cross-host embedding reuses chat-web surfaces instead of desktop shell panels", () => {
  const packagesReadme = readFileSync(join(root, "packages/README.md"), "utf8");
  const desktopShellReadme = readFileSync(
    join(root, "packages/vela-desktop-shell/README.md"),
    "utf8",
  );
  const chatWebReadme = readFileSync(
    join(root, "packages/vela-chat-web/README.md"),
    "utf8",
  );
  const desktopShellIndex = readFileSync(
    join(root, "packages/vela-desktop-shell/src/index.ts"),
    "utf8",
  );
  const chatWebSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/SessionListSurface.tsx"),
    "utf8",
  );

  assert.match(packagesReadme, /SessionListSurface/);
  assert.match(packagesReadme, /ChatSurface/);
  assert.match(packagesReadme, /must not import `VelaDesktopShell`/);
  assert.match(desktopShellReadme, /Desktop-only shell components/);
  assert.match(desktopShellReadme, /not the cross-host workbench API/);
  assert.match(desktopShellReadme, /Avoid adding generic names such as\s*`SessionPanel`/);
  assert.match(chatWebReadme, /Embeddable surfaces/);
  assert.match(chatWebReadme, /Host apps own layout around these surfaces/);
  assert.match(chatWebSurface, /export function SessionListSurface/);
  assert.doesNotMatch(desktopShellIndex, /SessionPanel/);
});

test("host-local state is created only by app hosts, not reusable shell chrome", () => {
  const shellSource = readFiles(
    listSourceFiles(join(root, "packages/vela-desktop-shell/src"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const desktopApp = readFiles([
    "apps/vela-desktop-electron/src/DesktopApp.tsx",
    "apps/vela-desktop-electron/src/hostState.ts",
  ]);
  const nextChatExample = readFiles([
    "app/chat/ChatWorkbench.tsx",
    "app/chat/workbench/hostState.ts",
  ]);

  assert.equal(existsSync(join(root, "packages/vela-chat-host-state/README.md")), true);
  assert.equal(existsSync(join(root, "packages/vela-chat-host-state/src/README.md")), true);
  assert.doesNotMatch(shellSource, /vela-chat-host-state/);
  assert.doesNotMatch(shellSource, /localStorage|sessionStorage/);
  assert.match(desktopApp, /createRuntimeHostStateStores/);
  assert.match(desktopApp, /createBrowserVelaClientStateStore/);
  assert.match(desktopApp, /createBrowserVelaShellLayoutStore/);
  assert.match(desktopApp, /createBrowserVelaSessionSelectionStore/);
  assert.match(desktopApp, /sessionSelectionStore/);
  assert.match(nextChatExample, /createChatExampleClientStateStore/);
  assert.match(nextChatExample, /createBrowserVelaClientStateStore/);
});

test("desktop app restores the selected session through host-local navigation state", () => {
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const hostState = readFileSync(
    join(root, "apps/vela-desktop-electron/src/hostState.ts"),
    "utf8",
  );

  assert.match(hostState, /sessionSelectionStore/);
  assert.match(renderer, /sessionSelectionStore\?\.read\(\)\?\.sessionId/);
  assert.match(renderer, /sessionSelectionStore\?\.write\(\{/);
  assert.match(renderer, /current && sessionList\.data\.sessions\.some/);
  assert.match(renderer, /sessionList\.data\.sessions\[0\]\?\.id \|\| ""/);
});

test("chat controller is headless and stays independent from desktop and Next shells", () => {
  const controllerSource = readFiles(
    listSourceFiles(join(root, "packages/vela-chat-controller/src"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );

  assert.match(controllerSource, /useVelaChatSession/);
  assert.match(controllerSource, /createVeladClient/);
  assert.match(controllerSource, /eventStreamTransport\.subscribe/);
  assert.doesNotMatch(controllerSource, /VelaDesktopShell/);
  assert.doesNotMatch(controllerSource, /SessionSidebar/);
  assert.doesNotMatch(controllerSource, /BrowserWindow/);
  assert.doesNotMatch(controllerSource, /next\/navigation/);
});

test("electron desktop app is the only layer that composes velad runtime, shell, controller, and ChatUI", () => {
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const main = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );
  const preload = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/preload.ts"),
    "utf8",
  );

  assert.match(renderer, /createVeladClient/);
  assert.match(renderer, /useVelaChatSession/);
  assert.match(renderer, /ChatSurface/);
  assert.match(renderer, /VelaDesktopShell/);
  assert.match(renderer, /SessionSidebar/);
  assert.match(renderer, /useSessionListViewQuery/);
  assert.match(renderer, /DESKTOP_SESSION_LIST_OPTIONS/);
  assert.doesNotMatch(renderer, /client\.listSessions\(\{ limit: 80 \}\)/);

  assert.match(main, /external velad/);
  assert.match(main, /BrowserWindow/);
  assert.match(main, /VELA_DESKTOP_VELAD_LISTEN_ADDR/);
  assert.match(main, /runtimeEnv/);
  assert.match(main, /spawn\(/);
  assert.match(main, /vela:desktop-info/);
  assert.doesNotMatch(main, /ChatSurface/);
  assert.doesNotMatch(main, /useVelaChatSession/);
  assert.match(preload, /vela:desktop-info/);
});

test("next web build excludes the standalone electron host from root type checking", () => {
  const tsconfig = readFileSync(join(root, "tsconfig.json"), "utf8");

  assert.match(tsconfig, /"apps\/vela-desktop-electron"/);
});

test("electron host has a real Vite dev and build pipeline instead of loading TS directly", () => {
  const packageJson = readFileSync(
    join(root, "apps/vela-desktop-electron/package.json"),
    "utf8",
  );
  const main = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );

  assert.match(packageJson, /"main":\s*"dist-electron\/main\.js"/);
  assert.match(packageJson, /"dev":\s*"node scripts\/dev\.mjs"/);
  assert.match(packageJson, /"dev:web":\s*"vite --config vite\.renderer\.config\.ts --host 127\.0\.0\.1"/);
  assert.match(packageJson, /"build":\s*"vite build --config vite\.electron\.config\.ts && esbuild electron\/preload\.ts/);
  assert.match(packageJson, /--outfile=dist-electron\/preload\.cjs && vite build --config vite\.renderer\.config\.ts"/);
  assert.equal(existsSync(join(root, "apps/vela-desktop-electron/vite.electron.config.ts")), true);
  assert.equal(existsSync(join(root, "apps/vela-desktop-electron/vite.renderer.config.ts")), true);
  assert.equal(existsSync(join(root, "apps/vela-desktop-electron/scripts/dev.mjs")), true);
  assert.match(main, /preload\.cjs/);
  assert.doesNotMatch(main, /preload\.ts/);
});

test("desktop web host can run as a pure browser app without Electron globals", () => {
  const bridge = readFileSync(
    join(root, "apps/vela-desktop-electron/src/desktopBridge.ts"),
    "utf8",
  );
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const viteRendererConfig = readFileSync(
    join(root, "apps/vela-desktop-electron/vite.renderer.config.ts"),
    "utf8",
  );
  const readme = readFileSync(
    join(root, "apps/vela-desktop-electron/README.md"),
    "utf8",
  );

  assert.match(bridge, /hostKind: "web"/);
  assert.match(bridge, /browserRuntimeHostBridge/);
  assert.match(bridge, /api_base_url/);
  assert.match(bridge, /VITE_VELA_API_BASE_URL/);
  assert.match(bridge, /DEFAULT_WEB_API_BASE_URL = "\/api\/v1"/);
  assert.match(viteRendererConfig, /VITE_VELA_PROXY_TARGET/);
  assert.match(viteRendererConfig, /"\/api\/v1"/);
  assert.match(renderer, /readRuntimeBootstrap/);
  assert.match(renderer, /DEFAULT_WEB_API_BASE_URL/);
  assert.doesNotMatch(renderer, /readElectronDesktopInfo/);
  assert.match(readme, /Pure web host mode/);
  assert.match(readme, /same-origin `\/api\/v1`/);
  assert.match(readme, /dev:web/);
});
