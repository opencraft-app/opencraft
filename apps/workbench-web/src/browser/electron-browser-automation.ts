import { serverFetch } from "../runtime/server-context";
import { BrowserAutomationError, type BrowserAutomation } from "@opencraft/browser-core";

interface GuestExecutor { executeJavaScript(code: string): Promise<any>; }
let bundle: Promise<string> | null = null;
function bridgeBundle(): Promise<string> {
  bundle ??= serverFetch("/__opencraft/preview-bridge.js").then(response => {
    if (!response.ok) throw new Error("Browser bridge bundle unavailable");
    return response.text();
  }).catch(error => { bundle = null; throw error; });
  return bundle;
}

/** Reuses the existing sensitive-field policy and semantic-input protocol.
 * Both bridge endpoints live inside the sandboxed guest. The only crossing is
 * a typed result from Electron, never an exposed Node/main-process capability.
 */
export function createElectronBrowserAutomation(guest: GuestExecutor, pageId: string, generation: number): BrowserAutomation {
  const key = `opencraft.guest.bridge.${crypto.randomUUID()}`;
  let disposed = false;
  let installed: Promise<void> | null = null;
  const call = async (method: string, input?: unknown) => {
    if (disposed) throw new BrowserAutomationError("PAGE_CLOSED", "Browser document is no longer active");
    installed ??= bridgeBundle().then(async code => {
      if (disposed) throw new Error("Browser document changed");
      await guest.executeJavaScript(`${code}\n;(() => {
        const api = OpenCraftPreviewBridgeRuntime;
        const cleanup = api.installPreviewBridgeRuntime({window, parentOrigin:location.origin});
        const adapter = new api.PreviewBridgeAdapter({
          hostWindow:window, frameWindow:window, targetOrigin:location.origin,
          previewId:${JSON.stringify(pageId)}, generation:${generation}
        });
        window[Symbol.for(${JSON.stringify(key)})] = {adapter, cleanup};
      })()`);
    });
    await installed;
    if (disposed) throw new BrowserAutomationError("PAGE_CLOSED", "Browser document changed");
    const result = await guest.executeJavaScript(`(() => {
      const state=window[Symbol.for(${JSON.stringify(key)})];
      if(!state) throw new Error("Browser document changed");
      return state.adapter[${JSON.stringify(method)}](${JSON.stringify(input ?? {})});
    })()`);
    if (disposed) throw new BrowserAutomationError("PAGE_CLOSED", "Browser document changed");
    return result;
  };
  return {
    capabilities: { protocolVersion: 1, backend: "preview-bridge", domInspection: true,
      semanticInput: true, trustedInput: false, networkObservation: "fetch-xhr", screenshot: false, deviceEmulation: "viewport-only" },
    readContext: options => call("readContext", options),
    inspect: () => call("inspect"),
    click: input => call("click", input),
    fill: input => call("fill", input),
    press: input => call("press", input),
    scroll: input => call("scroll", input),
    wait: input => call("wait", input),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (installed) void installed.then(() => guest.executeJavaScript(`(() => {
        const key=Symbol.for(${JSON.stringify(key)}), state=window[key];
        state?.adapter.dispose(); state?.cleanup(); delete window[key];
      })()`)).catch(() => {});
    },
  };
}
