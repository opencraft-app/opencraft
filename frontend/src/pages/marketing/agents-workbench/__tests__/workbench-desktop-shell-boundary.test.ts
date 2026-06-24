import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const readSource = (relativePath: string) =>
  readFileSync(join(root, relativePath), "utf8");

describe("agents workbench embedded shell boundary", () => {
  it("keeps the route page as a thin loader for the embedded Vela host", () => {
    const page = readSource("src/pages/marketing/agents-workbench/AgentsWorkbenchPage.tsx");

    expect(page).toMatch(/VelaWorkbenchDesktopHost/);
    expect(page).toMatch(/styles\.workbenchHost/);
    expect(page).toMatch(/execDebugCommand=\{repositories\.bots\.execDebugCommand\}/);
    expect(page).not.toMatch(/VelaSessionPanel/);
    expect(page).not.toMatch(/lg:grid-cols-\[300px_minmax\(0,1fr\)\]/);
  });

  it("uses a quiet auth-loading fallback for the workbench route", () => {
    const adapter = readSource("next-site/agents-page-client.tsx");

    expect(adapter).toMatch(/const loadingFallback = isWorkbench \? null : <AgentsRouteLoading \/>;/);
    expect(adapter).toMatch(/<AppRouteShell loadingFallback=\{loadingFallback\}>/);
  });

  it("uses embeddable Vela surfaces instead of any Vela desktop shell", () => {
    const host = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx");

    expect(host).toMatch(/ChatSurface/);
    expect(host).toMatch(/SessionListSurface/);
    expect(host).toMatch(/layout="contained"/);
    expect(host).toMatch(/buildVeladVmInstallCommand/);
    expect(host).not.toMatch(/WorkbenchEmbeddedFrame/);
    expect(host).not.toMatch(/styles\.sidebar/);
    expect(host).not.toMatch(/Update VM velad/);
    expect(host).not.toMatch(/Updating velad/);
    expect(host).not.toMatch(/installMessage/);
    expect(host).not.toMatch(/VelaChatWeb/);
    expect(host).not.toMatch(/VelaDesktopShell/);
    expect(host).not.toMatch(/SessionSidebar/);
    expect(host).not.toMatch(/DesktopSettingsPage/);
    expect(host).not.toMatch(/DesktopSettingsSidebar/);
    expect(host).not.toMatch(/DesktopEmptySurface/);
    expect(host).not.toMatch(/browserDesktopHostBridge/);
    expect(host).not.toMatch(/velachat\/apps\/vela-desktop-electron/);
  });

  it("keeps the workbench session rail host-owned while reusing the Vela list surface", () => {
    const host = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx");
    const css = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.module.css");

    expect(host).toMatch(/aria-label="Vela sessions"/);
    expect(host).toMatch(/styles\.sessionRail/);
    expect(host).toMatch(/<SessionListSurface/);
    expect(host).toMatch(/sessions=\{sessions\}/);
    expect(host).toMatch(/onSelectSession=\{setActiveSessionId\}/);
    expect(host).toMatch(/client\.getSessionListView\(\{ limit: 80 \}\)/);
    expect(css).toMatch(/\.sessionRail/);
    expect(css).toMatch(/:global\(\.vela-session-item\)/);
    expect(css).not.toMatch(/\.vela-desktop-shell/);
    expect(css).not.toMatch(/traffic-light|drag-region/i);
  });

  it("defaults the workbench to Hermes ACP without locking out other backends", () => {
    const host = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx");

    expect(host).toMatch(/const WORKBENCH_BACKEND_PREFERENCE = \["acp", "codex", "pi"\]/);
    expect(host).toMatch(/preferredBackends: WORKBENCH_BACKEND_PREFERENCE/);
    expect(host).not.toMatch(/backendOptions=\{controller\.backends\}/);
    expect(host).not.toMatch(/visibleBackendOptions\.map/);
    expect(host).not.toMatch(/styles\.backendField/);
    expect(host).not.toMatch(/<span>Backend<\/span>/);
    expect(host).not.toMatch(/filter\(\(backend\) => backend\.kind === "acp"\)/);
    expect(host).not.toMatch(/allowedBackends/);
  });

  it("keeps the embedded connection state quiet instead of showing vibe loader copy", () => {
    const host = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx");

    expect(host).not.toMatch(/Connecting to Vela/);
    expect(host).not.toMatch(/Connecting to Vela runtime/);
  });

  it("uses tail-only history in the TAT embedded workbench so background history cannot block the chat", () => {
    const host = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx");

    expect(host).toMatch(/historyPolicy:\s*"tail_only"/);
    expect(host).toMatch(/historyPhase=\{controller\.historyPhase\}/);
  });

  it("keeps VM velad installation in the workbench host, not the reusable ChatUI", () => {
    const release = readSource("src/pages/marketing/agents-workbench/velad-release.ts");
    const host = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx");

    expect(release).toMatch(/buildVeladVmInstallCommand/);
    expect(release).toMatch(/NEXT_PUBLIC_VELAD_RELEASE_URL/);
    expect(host).toMatch(/execDebugCommand\(bot\.id, command\)/);
    const chatSurface = host.match(/<ChatSurface[\s\S]*?\/>/)?.[0] ?? "";
    expect(chatSurface).not.toMatch(/execDebugCommand/);
  });

  it("auto-injects and starts VM velad before opening the TAT transport", () => {
    const host = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx");
    const readme = readSource("src/pages/marketing/agents-workbench/README.md");

    expect(host).toMatch(/autoVeladBootstrap/);
    expect(host).toMatch(/installVeladInVm\(\)/);
    expect(host).toMatch(/autoVeladReady/);
    expect(host).toMatch(/if \(!autoVeladReady\)/);
    expect(host).toMatch(/autoVeladBootstrap\?\.botId === bot\.id/);
    expect(host.indexOf("if (!autoVeladReady)")).toBeLessThan(
      host.indexOf("void createVmWorkbenchVeladTransport"),
    );
    expect(readme).toMatch(/Auto-inject and start VM `velad`/);
    expect(readme).not.toMatch(/Do not start `velad`/);
  });

  it("lets auto VM velad bootstrap complete even after the running state rerenders", () => {
    const host = readSource("src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx");

    expect(host).not.toMatch(/if \(!isAuto\) \{\s*setAutoVeladBootstrap/);
    expect(host).toMatch(
      /setAutoVeladBootstrap\(\{ botId: bot\.id, status: "succeeded" \}\);\s*setConnectAttempt/s,
    );
    expect(host).toMatch(/setAutoVeladBootstrap\(\{\s*botId: bot\.id,\s*status: "failed",\s*error:/);
  });

  it("uses separate TAT HTTP clients over one shared TSSH proxy for JSON APIs and event streams", () => {
    const transport = readSource("src/pages/marketing/agents-workbench/velad-transport.ts");

    expect(transport).toMatch(/new TencentTsshProxyClient\(bootstrap\)/);
    expect(transport).toMatch(/apiTatFetch/);
    expect(transport).toMatch(/streamTatFetch/);
    expect(transport).toMatch(/proxyClient,\s*responseHeaderTimeoutMs/s);
    expect(transport).toMatch(/keepAlive:\s*false/);
    expect(transport).toMatch(/closeDelimitedBodyIdleTimeoutMs:\s*300_000/);
    expect(transport).toMatch(/createVeladClient\(\{ baseUrl: LOCAL_VELAD_BASE_URL, fetch: apiFetchImpl \}\)/);
    expect(transport).toMatch(/createFetchVelaEventStreamTransport\(streamFetchImpl\)/);
    expect(transport).toMatch(/apiTatFetch\.close\(\)/);
    expect(transport).toMatch(/streamTatFetch\.close\(\)/);
    expect(transport).toMatch(/proxyClient\.close\(\)/);
  });

  it("starts VM velad with explicit ACP CloudAgents defaults without embedding secrets", () => {
    const release = readSource("src/pages/marketing/agents-workbench/velad-release.ts");

    expect(release).toMatch(/VELAD_ACP_API_KEY_VALUE/);
    expect(release).toMatch(/VELAD_ACP_COMMAND_VALUE="hermes"/);
    expect(release).toMatch(/VELAD_ACP_ARGS_VALUE="acp"/);
    expect(release).toMatch(/VELA_CLOUDAGENTS_API_KEY="\$VELAD_ACP_API_KEY_VALUE"/);
    expect(release).toMatch(/VELAD_ACP_API_KEY="\$VELAD_ACP_API_KEY_VALUE"/);
    expect(release).toMatch(/VELAD_ACP_COMMAND="\$VELAD_ACP_COMMAND_VALUE"/);
    expect(release).toMatch(/VELAD_ACP_ARGS="\$VELAD_ACP_ARGS_VALUE"/);
    expect(release).toMatch(/https:\/\/tokenhub\.tencentmaas\.com\/v1/);
    expect(release).toMatch(/minimax-m2\.7/);
    expect(release).toMatch(/VELAD_ACP_PROVIDER_VALUE="\$\{HERMES_INFERENCE_PROVIDER:-custom\}"/);
    expect(release).toMatch(/HERMES_INFERENCE_PROVIDER="\$VELAD_ACP_PROVIDER_VALUE"/);
    expect(release).toMatch(/HERMES_INFERENCE_MODEL="\$VELAD_ACP_MODEL_VALUE"/);
    expect(release).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(release).not.toMatch(/AKID[A-Za-z0-9]/);
  });

  it("keeps Makefile VM install command aligned with the workbench ACP defaults", () => {
    const script = readSource("../velalink/scripts/velad_vm_install_command.sh");

    expect(script).toMatch(/VELAD_ACP_API_KEY_VALUE/);
    expect(script).toMatch(/VELAD_ACP_COMMAND_VALUE="hermes"/);
    expect(script).toMatch(/VELAD_ACP_ARGS_VALUE="acp"/);
    expect(script).toMatch(/VELA_CLOUDAGENTS_API_KEY="\\\$VELAD_ACP_API_KEY_VALUE"/);
    expect(script).toMatch(/VELAD_ACP_API_KEY="\\\$VELAD_ACP_API_KEY_VALUE"/);
    expect(script).toMatch(/VELAD_ACP_COMMAND="\\\$VELAD_ACP_COMMAND_VALUE"/);
    expect(script).toMatch(/VELAD_ACP_ARGS="\\\$VELAD_ACP_ARGS_VALUE"/);
    expect(script).toMatch(/https:\/\/tokenhub\.tencentmaas\.com\/v1/);
    expect(script).toMatch(/minimax-m2\.7/);
    expect(script).toMatch(/VELAD_ACP_PROVIDER_VALUE="\\\$\{HERMES_INFERENCE_PROVIDER:-custom\}"/);
    expect(script).toMatch(/HERMES_INFERENCE_PROVIDER="\\\$VELAD_ACP_PROVIDER_VALUE"/);
    expect(script).toMatch(/HERMES_INFERENCE_MODEL="\\\$VELAD_ACP_MODEL_VALUE"/);
    expect(script).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(script).not.toMatch(/AKID[A-Za-z0-9]/);
  });

  it("does not load the Electron desktop stylesheet through the Next global css entry", () => {
    const globalCss = readSource("src/app/global.css");

    expect(globalCss).not.toMatch(/velachat\/apps\/vela-desktop-electron\/src\/style\.css/);
  });

  it("keeps a tiny Vite compatibility shell for the trusted base frontend guard", () => {
    const indexHtml = readSource("index.html");
    const viteMain = readSource("src/vite-compat-main.ts");
    const viteConfig = readSource("vite.config.ts");

    expect(indexHtml).toMatch(/src\/vite-compat-main\.ts/);
    expect(viteMain).toMatch(/LightVela Vite compatibility shell/);
    expect(viteConfig).toMatch(/defineConfig/);
    expect(viteMain).not.toMatch(/mountApp|createRoot|AppRouteShell|AgentsWorkbenchPage/);
  });

  it("keeps embedded workbench sizing local instead of patching desktop shell globals", () => {
    const css = readSource("src/pages/marketing/agents-workbench/AgentsWorkbenchPage.module.css");

    expect(css).toMatch(/\.workbenchHost/);
    expect(css).toMatch(/--workbench-product-header-height:\s*61px/);
    expect(css).toMatch(/position:\s*fixed/);
    expect(css).toMatch(/inset:\s*var\(--workbench-product-header-height\)\s+0\s+0/);
    expect(css).toMatch(/width:\s*100%/);
    expect(css).toMatch(/height:\s*auto/);
    expect(css).not.toMatch(/\.vela-sidebar-provider/);
    expect(css).not.toMatch(/\.vela-desktop-shell/);
  });
});
