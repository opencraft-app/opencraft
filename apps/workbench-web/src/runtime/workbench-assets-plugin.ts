import { combineAbortSignals } from "@opencraft/appserver-client/transport";
import type { LocaleCatalog } from "@opencraft/i18n";
import type { ServerAssetsContribution } from "@opencraft/plugin-assets/client";
import { reportRuntimeError } from "../runtime-error-reporting";
import { readPinnedExtensionModule } from "./module-url-extension-loader";
import { serverUrl } from "./server-context";

async function assetsPluginModules() {
  const [{ trustedRendererModules }, { SettingsCollectionSection }, { useGitConnectionController }] = await Promise.all([
    import("./trusted-renderer-host"),
    import("@opencraft/extension-react/settings-collection"),
    import("@opencraft/plugin-assets/git/client"),
  ]);
  const shared = trustedRendererModules();
  return Object.freeze({
    react: shared.react,
    "react/jsx-runtime": shared["react/jsx-runtime"],
    "@opencraft/i18n/react": shared["@opencraft/i18n/react"],
    "@opencraft/extension-react": shared["@opencraft/extension-react"],
    "@opencraft/extension-react/settings-collection": Object.freeze({ SettingsCollectionSection }),
    "@opencraft/plugin-assets/git/client": Object.freeze({ useGitConnectionController }),
  });
}

interface WorkbenchAssetsContribution {
  readonly assets: { readonly git: NonNullable<ServerAssetsContribution["git"]> };
  readonly localeCatalogs?: readonly LocaleCatalog[];
}

/** Browser contract for a self-contained operator-selected Assets plugin. */
export interface WorkbenchAssetsPluginV1 {
  readonly apiVersion: 1;
  create(modules: Awaited<ReturnType<typeof assetsPluginModules>>): WorkbenchAssetsContribution;
}

export async function loadWorkbenchAssetsPlugin(document: Document, signal: AbortSignal): Promise<WorkbenchAssetsContribution | undefined> {
  const descriptor = document.getElementById("opencraft-workbench-assets-plugin")?.textContent;
  if (!descriptor) return undefined;
  const { apiVersion, sha256 } = JSON.parse(descriptor);
  if (apiVersion !== 1 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw Error("Invalid Workbench Assets plugin selection");
  }
  const request = combineAbortSignals([signal, AbortSignal.timeout(8000)]);
  const module = await fetch(serverUrl(`/__opencraft_workbench_assets_plugin/${sha256}.mjs`), {
    credentials: "same-origin", cache: "no-store", redirect: "error", signal: request.signal,
  }).then(response => readPinnedExtensionModule(response, sha256)).finally(request.dispose);
  const plugin = module.default as Partial<WorkbenchAssetsPluginV1> | undefined;
  if (plugin?.apiVersion !== 1 || typeof plugin.create !== "function") throw Error("Unsupported Workbench Assets plugin");
  const modules = await assetsPluginModules();
  signal.throwIfAborted();
  const contribution = plugin.create(modules);
  const git = contribution?.assets?.git;
  if (!git || typeof git.host !== "string" || !/^[a-z0-9.-]{1,253}$/u.test(git.host) || typeof git.load !== "function"
    || (contribution.localeCatalogs !== undefined && (!Array.isArray(contribution.localeCatalogs)
      || contribution.localeCatalogs.some(catalog => typeof catalog?.locale !== "string" || typeof catalog.load !== "function")))) {
    throw Error("Invalid Workbench Assets contribution");
  }
  return {
    ...contribution,
    assets: {
      git: {
        host: git.host,
        async load(fetcher) {
          try { return await git.load(fetcher); }
          catch (error) {
            reportRuntimeError(error, "workbench-assets-plugin");
            return undefined;
          }
        },
      },
    },
  };
}
