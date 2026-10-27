import { parseExtensionManifestV1, type OpenCraftExtensionApiV1 } from "@opencraft/extension-contract";
import { parseExtensionArtifact, type ExtensionArtifact } from "@opencraft/extension-runtime";
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

async function assertSelfContained(code: string): Promise<void> {
  const { parse } = await import("acorn");
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression" || node.type === "MetaProperty"
      || ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source)) {
      throw new TypeError("Extension must bundle its dependencies; imports and import.meta are unsupported in pinned modules");
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(parse(code, { ecmaVersion: "latest", sourceType: "module" }));
}

async function digest(code: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function importArtifact(code: string): Promise<ExternalExtensionModule> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try { return await import(/* @vite-ignore */ url) as ExternalExtensionModule; }
  finally { URL.revokeObjectURL(url); }
}

async function readModule(response: Response): Promise<string> {
  if (!response.body) throw new Error("Extension download returned no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let code = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) throw new Error("Extension module exceeds 512 KiB");
      code += decoder.decode(value, { stream: true });
    }
    return code + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

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
    private readonly ports = { fetch: globalThis.fetch.bind(globalThis), importArtifact },
  ) {}

  async load(
    source: ExtensionInstallationSource,
    options: { readonly fresh?: boolean; readonly artifact?: ExtensionArtifact } = {},
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
    let artifact: ExtensionArtifact;
    if (options.artifact !== undefined) {
      artifact = parseExtensionArtifact(options.artifact);
      if (await digest(artifact.code) !== artifact.sha256) throw new Error("Extension artifact integrity check failed");
    } else {
      const response = await this.ports.fetch(url.href, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Extension download failed (${response.status})`);
      const code = await readModule(response);
      artifact = parseExtensionArtifact({ format: "esm", code, sha256: await digest(code) });
    }
    await assertSelfContained(artifact.code);
    const loaded = await this.ports.importArtifact(artifact.code);
    const external = externalDefinition(loaded.default ?? loaded.extension);
    const manifest = parseExtensionManifestV1(external.manifest);
    return Object.freeze({
      manifest,
      artifact,
      activate(api: TrustedExtensionApiV1) {
        const publicApi: OpenCraftExtensionApiV1 = Object.freeze({
          signal: api.signal,
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
