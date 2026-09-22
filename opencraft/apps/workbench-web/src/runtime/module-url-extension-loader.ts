import { parseExtensionManifestV1, type OpenCraftExtensionApiV1 } from "@opencraft/extension-contract";
import type {
  ExtensionModuleLoader,
  ExtensionInstallationSource,
  TrustedExtensionDefinition,
  TrustedExtensionApiV1,
} from "@opencraft/extension-runtime";

type ExternalExtensionModule = {
  readonly default?: unknown;
  readonly extension?: unknown;
};

function externalDefinition(value: unknown): {
  readonly manifest: unknown;
  readonly activate: (api: OpenCraftExtensionApiV1) => unknown;
} {
  if (typeof value !== "object" || value === null) throw new TypeError("Extension entry must export an object");
  const candidate = value as { readonly manifest?: unknown; readonly activate?: unknown };
  if (typeof candidate.activate !== "function") throw new TypeError("Extension entry requires activate(api)");
  return {
    manifest: candidate.manifest,
    activate: candidate.activate as (api: OpenCraftExtensionApiV1) => unknown,
  };
}

export class BrowserModuleUrlExtensionLoader implements ExtensionModuleLoader {
  constructor(
    private readonly baseUrl = window.location.href,
    private readonly now: () => number = Date.now,
  ) {}

  async load(
    source: ExtensionInstallationSource,
    options: { readonly fresh?: boolean } = {},
  ): Promise<TrustedExtensionDefinition> {
    if (source.kind !== "module-url") throw new TypeError(`Unsupported extension source ${source.kind}`);
    const url = new URL(source.url, this.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("module-url extensions require an HTTP(S) URL");
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new TypeError("Credentials are not allowed in extension module URLs");
    }
    if (new URL(this.baseUrl).protocol === "https:" && url.protocol !== "https:") {
      throw new TypeError("HTTPS OpenCraft cannot load an insecure extension module");
    }
    if (options.fresh) url.searchParams.set("opencraft_reload", String(this.now()));
    const loaded = await import(/* @vite-ignore */ url.href) as ExternalExtensionModule;
    const external = externalDefinition(loaded.default ?? loaded.extension);
    const manifest = parseExtensionManifestV1(external.manifest);
    return Object.freeze({
      manifest,
      activate(api: TrustedExtensionApiV1) {
        const publicApi: OpenCraftExtensionApiV1 = Object.freeze({
          identity: api.identity,
          storage: api.storage,
          subscriptions: api.subscriptions,
          commands: api.commands,
          settings: api.settings,
          views: api.views,
          navigation: api.navigation,
          sidebar: api.sidebar,
          workbench: api.workbench,
          themes: api.themes,
          bots: api.bots,
          window: api.window,
        });
        return external.activate(publicApi) as ReturnType<TrustedExtensionDefinition["activate"]>;
      },
    });
  }
}
