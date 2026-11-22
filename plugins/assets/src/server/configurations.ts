import { ManagedNfsLibraries } from "./libraries.js";
import { validateInstalledPolicy, type InstalledSandboxPolicy } from "./installed-policy.js";
import { randomUUID, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import type { E2BCredential, SandboxConfiguration, SandboxConfigurationsSnapshot } from "../contract.js";
import { PLATFORM_ASSET_SCOPE, type AssetSource } from "../contract.js";
import {
  storedCredential,
  storedCredentialBackend,
  type SandboxCredential,
  type SandboxInstallation,
} from "./sandbox-installations.js";
/** Validated installation delivery; never accepted from an HTTP body. */
export type InstalledSandboxConfiguration = SandboxInstallation & {
  capacity: InstalledSandboxPolicy["capacity"];
  lease: InstalledSandboxPolicy["lease"];
  maxCommandMs?: number;
  persistentWorkspaces?: boolean;
  templates: (Omit<InstalledSandboxPolicy["templates"][number], "environmentId"> & { id: string; name: string })[];
};
const namespace = "document-sandbox-configurations";
type PrivateCredential = SandboxCredential;
interface Document {
  version: 1;
  installation?: InstalledSandboxPolicy;
  credentials: PrivateCredential[];
  environments: (Omit<SandboxConfiguration, "credentialId" | "source"> & {
    credentialId: string;
  })[];
}
import { SandboxConfigurationError } from "./errors.js";
export { SandboxConfigurationError } from "./errors.js";
function fail(code = "invalid", status = 400): never {
  throw new SandboxConfigurationError(code, status);
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 120): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail();
  return value.trim();
};
export function e2bEndpoint(raw: unknown): string {
  const value = text(raw, 512);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    fail();
  return url.origin;
}
const custom = (c: Pick<E2BCredential, "apiUrl" | "sandboxUrl">) =>
  c.apiUrl !== "https://api.e2b.dev" || c.sandboxUrl !== "https://e2b.dev";
/** Domain-owned configuration in the existing encrypted vault. Not a generic asset store.
 * Credentials exist independently; public projections never include secret bytes. */
export class SandboxConfigurations {
  constructor(readonly vault: Pick<EmployeeGitVaultStore, "readDocument" | "writeDocument">) {}
  private read(scope: string): { revision: number; document: Document } {
    const stored = this.vault.readDocument(scope, namespace);
    if (stored.document === null)
      return {
        revision: stored.revision,
        document: { version: 1, credentials: [], environments: [] },
      };
    const doc = object(stored.document) as unknown as Omit<Document, "credentials"> & { credentials: unknown[] };
    if (doc.version !== 1 || !Array.isArray(doc.credentials) || !Array.isArray(doc.environments))
      fail("unavailable", 503);
    const credentials: PrivateCredential[] = [];
    try {
      if (
        Object.keys(doc).some((k) => !["version", "credentials", "environments", "installation"].includes(k)) ||
        doc.credentials.length > 32 ||
        doc.environments.length > 32
      )
        fail();
      if (doc.installation) {
        if (scope !== PLATFORM_ASSET_SCOPE) fail();
        validateInstalledPolicy(doc.installation);
      }
      const ids = new Set<string>();
      for (const raw of doc.credentials) {
        const c = object(raw);
        // Version-1 credentials have no `backend`; they are E2B (see sandbox-installations).
        const backend = storedCredentialBackend(c);
        if (
          Object.keys(c).some(
            (k) => !["backend", "id", "name", "apiUrl", "sandboxUrl", "generation", "apiKey"].includes(k),
          )
        )
          fail();
        const id = text(c.id, 64);
        if (ids.has(id)) fail();
        ids.add(id);
        text(c.name);
        text(c.generation, 64);
        if (
          e2bEndpoint(c.apiUrl) !== c.apiUrl ||
          e2bEndpoint(c.sandboxUrl) !== c.sandboxUrl ||
          !text(c.apiKey, 4096) ||
          /\s/u.test(c.apiKey as string)
        )
          fail();
        credentials.push({
          backend,
          id: c.id as string,
          name: c.name as string,
          apiUrl: c.apiUrl as string,
          sandboxUrl: c.sandboxUrl as string,
          generation: c.generation as string,
          apiKey: c.apiKey as string,
        });
      }
      const environments = new Set<string>();
      for (const e of doc.environments) {
        if (Object.keys(object(e)).some((k) => !["id", "name", "credentialId", "templateId"].includes(k))) fail();
        if (
          environments.has(text(e.id, 64)) ||
          !ids.has(e.credentialId) ||
          !/^[a-zA-Z0-9_-]{1,128}$/u.test(e.templateId)
        )
          fail();
        environments.add(e.id);
        text(e.name);
      }
    } catch {
      fail("unavailable", 503);
    }
    return { revision: stored.revision, document: { ...structuredClone(doc), credentials } };
  }
  private write(scope: string, revision: number, document: Document) {
    this.vault.writeDocument(scope, namespace, revision, {
      ...document,
      credentials: document.credentials.map(storedCredential),
    });
  }
  hasInstallation() {
    return !!this.read(PLATFORM_ASSET_SCOPE).document.installation;
  }
  /** Installation-only migration; never exposed as an HTTP action. */
  adoptInstallation(config: InstalledSandboxConfiguration, apiKey: string) {
    const { revision, document } = this.read(PLATFORM_ASSET_SCOPE);
    if (document.installation) return false;
    const credentialId = randomUUID();
    if (!apiKey || /\s/u.test(apiKey)) fail("key_required");
    let credential: PrivateCredential;
    switch (config.backend) {
      case "e2b":
        credential = {
          backend: "e2b",
          id: credentialId,
          name: "E2B",
          apiUrl: e2bEndpoint(config.apiUrl),
          sandboxUrl: e2bEndpoint(config.sandboxUrl),
          apiKey,
          generation: randomUUID(),
        };
        break;
      default:
        return fail();
    }
    const templates = config.templates.map((t) => {
      const environmentId = "installed-" + createHash("sha256").update(t.id).digest("hex").slice(0, 32);
      if (document.environments.some((e) => e.id === environmentId)) fail("conflict", 409);
      document.environments.push({
        id: environmentId,
        name: text(t.name),
        credentialId,
        templateId: text(t.id, 128),
      });
      return {
        environmentId,
        workspaceRoot: t.workspaceRoot,
        resources: t.resources,
        ...(t.python ? { python: t.python } : {}),
        ...(t.browser !== undefined ? { browser: structuredClone(t.browser) } : {}),
      };
    });
    document.installation = {
      backendId: credential.backend,
      capacity: config.capacity,
      lease: config.lease,
      maxCommandMs: config.maxCommandMs ?? 60000,
      persistentWorkspaces: config.persistentWorkspaces ?? false,
      templates,
    };
    validateInstalledPolicy(document.installation);
    document.credentials.push(credential);
    if (document.credentials.length > 32 || document.environments.length > 32) fail("limit");
    this.write(PLATFORM_ASSET_SCOPE, revision, document);
    return true;
  }
  /** Host-only view: secret bytes never enter snapshot/HTTP responses. */
  installedRuntime() {
    const { document } = this.read(PLATFORM_ASSET_SCOPE),
      policy = document.installation;
    if (!policy) return null;
    const records = policy.templates.flatMap((t) => {
      const environment = document.environments.find((e) => e.id === t.environmentId);
      const credential = environment && document.credentials.find((c) => c.id === environment.credentialId);
      // An installation selects exactly one provider; never mix credentials of another backend.
      return environment && credential && credential.backend === policy.backendId
        ? [{ environment, credential, policy: t }]
        : [];
    });
    return { policy, records };
  }
  snapshot(scope: string, allowCustomEndpoints: boolean, canManagePlatform = false): SandboxConfigurationsSnapshot {
    const { revision, document } = this.read(scope);
    const platform = this.read(PLATFORM_ASSET_SCOPE);
    const installed = this.installedRuntime();
    const library = new ManagedNfsLibraries(this.vault).snapshot(
      (installed?.records ?? []).map((r) => ({
        environmentId: r.environment.id,
        templateId: r.environment.templateId,
        credentialId: r.credential.id,
        credentialGeneration: r.credential.generation,
      })),
    );
    const metadata = (c: PrivateCredential) => ({
      id: c.id,
      name: c.name,
      apiUrl: c.apiUrl,
      sandboxUrl: c.sandboxUrl,
      generation: c.generation,
    });
    return {
      scope,
      revision,
      allowCustomEndpoints,
      canManagePlatform,
      platformRevision: platform.revision,
      libraryRevision: library.revision,
      libraries: library.libraries,
      environments: [
        ...document.environments,
        ...platform.document.environments.map(({ credentialId, ...e }) => ({
          ...e,
          ...(canManagePlatform ? { credentialId } : {}),
          source: "platform" as const,
        })),
      ],
      credentials: [
        ...document.credentials.map(metadata),
        ...(canManagePlatform
          ? platform.document.credentials.map((c) => ({
              ...metadata(c),
              source: "platform" as const,
            }))
          : []),
      ],
    };
  }
  update(scope: string, raw: unknown, allowCustomEndpoints: boolean, canManagePlatform = false) {
    const input = object(raw);
    if (input.source !== undefined && input.source !== "personal" && input.source !== "platform") fail();
    const platform = input.source === "platform";
    if (platform && !canManagePlatform) fail("administrator_required", 403);
    const target = platform ? PLATFORM_ASSET_SCOPE : scope;
    const { revision, document } = this.read(target);
    if (!Number.isSafeInteger(input.revision) || input.revision !== revision) fail("conflict", 409);
    const actions: Record<string, string[]> = {
      "save-credential": ["id", "name", "apiUrl", "sandboxUrl", "apiKey"],
      "delete-credential": ["id"],
      "save-environment": ["id", "name", "credentialId", "templateId"],
      "delete-environment": ["id"],
    };
    if (
      typeof input.action !== "string" ||
      !Object.hasOwn(actions, input.action) ||
      Object.keys(input).some((k) => !["revision", "source", "action", ...actions[input.action as string]!].includes(k))
    )
      fail();
    const id = input.id === undefined ? randomUUID() : text(input.id, 64);
    if (input.action === "save-credential") {
      const previous = document.credentials.find((c) => c.id === id);
      if (input.id !== undefined && !previous) fail("missing", 404);
      const apiUrl = e2bEndpoint(input.apiUrl),
        sandboxUrl = e2bEndpoint(input.sandboxUrl);
      if (custom({ apiUrl, sandboxUrl }) && !allowCustomEndpoints) fail("custom_endpoint_admin", 403);
      // An existing secret cannot be redirected to a different audience.
      if (previous && (previous.apiUrl !== apiUrl || previous.sandboxUrl !== sandboxUrl)) fail("audience_changed");
      const apiKey = input.apiKey === undefined || input.apiKey === "" ? previous?.apiKey : text(input.apiKey, 4096);
      if (!apiKey || /\s/u.test(apiKey)) fail("key_required");
      // The settings editor manages E2B credentials only.
      if (previous && previous.backend !== "e2b") fail("audience_changed");
      const credential: PrivateCredential = {
        backend: "e2b",
        id,
        name: text(input.name),
        apiUrl,
        sandboxUrl,
        apiKey,
        generation: previous && apiKey === previous.apiKey ? previous.generation : randomUUID(),
      };
      document.credentials = document.credentials.filter((c) => c.id !== id).concat(credential);
    } else if (input.action === "delete-credential") {
      if (document.environments.some((e) => e.credentialId === id)) fail("credential_in_use", 409);
      if (!document.credentials.some((c) => c.id === id)) fail("missing", 404);
      document.credentials = document.credentials.filter((c) => c.id !== id);
    } else if (input.action === "save-environment") {
      if (input.id !== undefined && !document.environments.some((e) => e.id === id)) fail("missing", 404);
      const credentialId = text(input.credentialId, 64),
        credential = document.credentials.find((c) => c.id === credentialId);
      if (!credential) fail("credential_missing");
      if (custom(credential) && !allowCustomEndpoints) fail("custom_endpoint_admin", 403);
      const templateId = text(input.templateId, 128);
      if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(templateId)) fail("invalid_template");
      document.environments = document.environments
        .filter((e) => e.id !== id)
        .concat({ id, name: text(input.name), credentialId, templateId });
    } else {
      if (!document.environments.some((e) => e.id === id)) fail("missing", 404);
      document.environments = document.environments.filter((e) => e.id !== id);
    }
    if (document.credentials.length > 32 || document.environments.length > 32) fail("limit");
    if (document.installation) {
      const ids = document.installation.templates.map((t) => t.environmentId);
      const templates = document.environments.filter((e) => ids.includes(e.id)).map((e) => e.templateId);
      if (new Set(templates).size !== templates.length) fail("duplicate_template");
    }
    this.write(target, revision, document);
    return this.snapshot(scope, allowCustomEndpoints, canManagePlatform);
  }
  /** Host-only projection. A saved configuration never creates a sandbox. */
  runtime(scope: string, allowCustomEndpoints: boolean, source: AssetSource = "personal") {
    const { document } = this.read(source === "platform" ? PLATFORM_ASSET_SCOPE : scope);
    return document.environments.flatMap((environment) => {
      const credential = document.credentials.find((c) => c.id === environment.credentialId);
      return credential && (!custom(credential) || allowCustomEndpoints) ? [{ environment, credential }] : [];
    });
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: {
      scope: string;
      current(): boolean;
      allowCustomEndpoints(): boolean;
      canManagePlatform?(): boolean;
    },
  ) {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (!context.current()) return reply(403, { error: "forbidden" });
      if (request.headers["x-opencraft-account-scope"] !== context.scope)
        return reply(409, { error: "account_changed" });
      if (request.method === "GET")
        return reply(
          200,
          this.snapshot(context.scope, context.allowCustomEndpoints(), context.canManagePlatform?.() ?? false),
        );
      if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
      if (request.headers["content-type"] !== "application/json") return reply(415, { error: "json_required" });
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const data = Buffer.from(chunk);
        size += data.length;
        if (size > 16384) return reply(413, { error: "too_large" });
        chunks.push(data);
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400, { error: "invalid" });
      }
      if (!context.current()) return reply(403, { error: "forbidden" });
      const snapshot = this.update(
        context.scope,
        value,
        context.allowCustomEndpoints(),
        context.canManagePlatform?.() ?? false,
      );
      return reply(200, snapshot);
    } catch (error) {
      const known =
        error instanceof SandboxConfigurationError || (error instanceof Error && error.message === "conflict");
      reply(known ? ((error as SandboxConfigurationError).status ?? 409) : 503, {
        error: known ? error.message : "unavailable",
      });
    }
  }
}
