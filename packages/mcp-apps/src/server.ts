import { MCP_APPS_GUIDE } from "./instructions";
import { AppStore } from "./store";
import {
  appId,
  object,
  validateSpec,
  validateJavascript,
  compileSchema,
  type AppSpec,
} from "./spec";
import { javascript } from "./javascript";
import { builderHtml } from "./manager-ui";
import type { AppReference } from "./history-access";
import {
  ownsServer,
  MCP_APPS_SERVER,
  MCP_APPS_URI,
  MCP_APPS_METHOD,
  MCP_APPS_DYNAMIC_TOOLS,
  MCP_APP_RESOURCE_META,
} from "@opencraft/appserver-protocol/mcp-apps";
export {
  MCP_APPS_SERVER,
  MCP_APPS_URI,
  MCP_APPS_METHOD,
} from "@opencraft/appserver-protocol/mcp-apps";
const prefix = "opencraft-app-";
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid integer");
  return Number(v);
}
function result(data: unknown, text?: string) {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data) }],
    structuredContent:
      data && typeof data === "object" && !Array.isArray(data)
        ? data
        : { value: data },
  };
}
export class McpAppsService {
  readonly store: AppStore;
  private closed = false;
  constructor(path: string) {
    this.store = new AppStore(path);
  }
  get outcome() {
    return this.store.outcome;
  }
  close() {
    this.closed = true;
    this.store.close();
  }
  private current(assertCurrent: () => void) {
    if (this.closed) throw new Error("App service closed");
    assertCurrent();
  }
  async manage(
    owner: string,
    input: unknown,
    assertCurrent: () => void = () => {},
  ) {
    this.current(assertCurrent);
    const p = object(input),
      action = p.action;
    if (
      Object.keys(p).some(
        (k) =>
          ![
            "action",
            "appId",
            "spec_json",
            "expectedVersion",
            "revision",
            "offset",
            "limit",
          ].includes(k),
      )
    )
      throw new Error("Unknown management field");
    if (action === "openBuilder")
      return {
        kind: "opencraft-mcp-app",
        server: MCP_APPS_SERVER,
        resourceUri: MCP_APPS_URI,
        result: result({ title: "MCP App Builder" }),
      };
    if (action === "help") return { guide: MCP_APPS_GUIDE };
    if (action === "list")
      return this.store.list(
        owner,
        integer(p.offset ?? 0, 0, 64),
        integer(p.limit ?? 20, 1, 20),
      );
    if (action === "validate") {
      const spec = validateSpec(p.spec_json);
      await validateJavascript(spec);
      this.current(assertCurrent);
      return { valid: true, appId: spec.appId };
    }
    const id = appId(p.appId);
    if (action === "get") {
      const row = this.store.get(owner, id);
      if (!row) throw new Error("App not found");
      if (p.revision !== undefined) {
        const revision = integer(p.revision, 1, 64),
          release = this.store.release(owner, id, revision);
        if (!release) throw new Error("Release not found");
        return {
          appId: id,
          version: row.version,
          activeRevision: row.active,
          revision,
          resourceUri: release.uri,
          spec: JSON.parse(release.spec),
        };
      }
      return {
        appId: id,
        version: row.version,
        activeRevision: row.active,
        nextRevision: row.next,
        deleted: row.deleted === 1,
        draft: JSON.parse(row.draft),
        releases: this.store.revisions(owner, id),
      };
    }
    if (action === "open") {
      const release = this.active(owner, id),
        spec = JSON.parse(release.spec) as AppSpec;
      const data = { appId: id, revision: release.revision, title: spec.title };
      return {
        kind: "opencraft-mcp-app",
        server: `${prefix}${id}-r${release.revision}`,
        resourceUri: release.uri,
        result: result(data),
      };
    }
    if (
      !["saveDraft", "publish", "rollback", "unpublish", "delete"].includes(
        String(action),
      )
    )
      throw new Error("Unknown management action");
    const version = integer(p.expectedVersion, 0, Number.MAX_SAFE_INTEGER),
      revision = action === "rollback" ? integer(p.revision, 1, 64) : undefined;
    let spec: AppSpec | undefined;
    if (action === "saveDraft" || action === "publish") {
      spec = validateSpec(p.spec_json);
      if (spec.appId !== id) throw new Error("App ID mismatch");
      await validateJavascript(spec);
    }
    this.current(assertCurrent); // validation yielded: revocation must precede commit.
    const row = this.store.mutate(
      owner,
      id,
      version,
      String(action),
      spec,
      revision,
    );
    return row
      ? {
          appId: id,
          version: row.version,
          deleted: row.deleted === 1,
          activeRevision: row.active,
          releases: this.store.revisions(owner, id),
        }
      : { deleted: true, appId: id };
  }
  private active(owner: string, id: string, revision?: number) {
    const row = this.store.get(owner, id);
    if (!row?.active || (revision !== undefined && row.active !== revision))
      throw new Error("App release is inactive");
    const release = this.store.release(owner, id, row.active);
    if (!release) throw new Error("App release not found");
    return release;
  }
  private fromServer(owner: string, server: string, references: readonly AppReference[] = [], uri?: unknown) {
    const match = /^opencraft-app-([a-z][a-z0-9-]{1,39})-r([1-9][0-9]*)$/.exec(
      server,
    );
    if (!match) throw new Error("Unknown App server");
    const candidates = references.filter(r => r.server === server && (uri === undefined || r.resourceUri === uri));
    const own = this.store.get(owner, match[1]!);
    const ownRelease = own?.active === Number(match[2]) ? this.store.release(owner, match[1]!, own.active) : null;
    if (ownRelease && (uri === undefined || ownRelease.uri === uri)) {
      if (uri === undefined && candidates.some(r => r.resourceUri !== ownRelease.uri))
        throw new Error("Ambiguous App reference; reopen with its resource URI");
      return ownRelease;
    }
    if (candidates.length > 1) throw new Error("Ambiguous App reference; reopen with its resource URI");
    if (candidates.length === 1) {
      const release = this.store.referencedRelease(candidates[0]!.resourceUri, match[1]!, Number(match[2]));
      if (release) return this.active(release.owner, release.id, release.revision);
    }
    if (uri !== undefined && ownRelease) throw new Error("App resource not found");
    return this.active(owner, match[1]!, Number(match[2]));
  }
  inventory(owner: string, references: readonly AppReference[] = []) {
    const common = {
      runtimeStatus: null,
      pluginId: null,
      serverInfo: {
        name: "OpenCraft Apps",
        title: "OpenCraft Apps",
        version: "1",
        description: null,
        icons: null,
        websiteUrl: null,
      },
      serverCapabilities: { tools: {}, resources: {} },
      toolsError: null,
    };
    const builder = {
      ...common,
      name: MCP_APPS_SERVER,
      authStatus: "unsupported",
      tools: {
        manage: {
          name: "manage",
          description: MCP_APPS_GUIDE,
          inputSchema: MCP_APPS_DYNAMIC_TOOLS[0]!.tools[0]!.inputSchema,
          _meta: { ui: { resourceUri: MCP_APPS_URI, visibility: ["app"] } },
        },
      },
      resources: [
        {
          uri: MCP_APPS_URI,
          name: "MCP App Builder",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
      resourceTemplates: [],
    };
    const releases = this.store.list(owner, 0, 64).apps.flatMap((a) => {
      if (!a.activeRevision) return [];
      return [this.active(owner, String(a.appId))];
    });
    for (const ref of references) {
      try {
        const rel = this.fromServer(owner, ref.server, references, ref.resourceUri);
        if (!releases.some(r => r.owner === rel.owner && r.id === rel.id && r.revision === rel.revision)) releases.push(rel);
      } catch { /* Revoked, deleted or replaced releases never reappear through history. */ }
    }
    const apps = releases.flatMap(rel => {
      const spec = JSON.parse(rel.spec) as AppSpec;
      return [
        {
          ...common,
          name: `${prefix}${spec.appId}-r${rel.revision}`,
          authStatus: "unsupported",
          tools: Object.fromEntries(
            spec.tools.map((t) => [
              t.name,
              {
                name: t.name,
                title: t.title,
                description: t.description,
                inputSchema: t.inputSchema,
                ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
                annotations: { readOnlyHint: t.readOnlyHint },
                _meta: {
                  ui: { resourceUri: rel.uri, visibility: ["app", "model"] },
                  "ui/resourceUri": rel.uri,
                },
              },
            ]),
          ),
          resources: [
            {
              uri: rel.uri,
              name: spec.title,
              mimeType: "text/html;profile=mcp-app",
            },
          ],
          resourceTemplates: [],
        },
      ];
    });
    return [builder, ...apps];
  }
  async handle(
    owner: string,
    method: string,
    input: unknown,
    assertCurrent: () => void = () => {},
    references: readonly AppReference[] | (() => readonly AppReference[]) = [],
  ) {
    this.current(assertCurrent);
    const p = object(input);
    const currentReferences = () => typeof references === "function" ? references() : references;
    if (method === MCP_APPS_METHOD)
      return this.manage(owner, input, assertCurrent);
    const server = String(p.server);
    if (!ownsServer(server)) throw new Error("Unknown App server");
    if (method === "mcpServer/resource/read") {
      const html =
        server === MCP_APPS_SERVER
          ? p.uri === MCP_APPS_URI
            ? builderHtml
            : null
          : (() => {
              const r = this.fromServer(owner, server, currentReferences(), p.uri);
              return r.uri === p.uri
                ? (JSON.parse(r.spec) as AppSpec).uiHtml
                : null;
            })();
      if (html === null) throw new Error("App resource not found");
      return {
        originCallId: p.originCallId ?? null,
        contents: [
          {
            uri: p.uri,
            mimeType: "text/html;profile=mcp-app",
            text: html,
            _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
          },
        ],
      };
    }
    if (method !== "mcpServer/tool/call")
      throw new Error("Unsupported App method");
    if (server === MCP_APPS_SERVER) {
      if (p.tool !== "manage") throw new Error("Unknown builder tool");
      return result(await this.manage(owner, p.arguments, assertCurrent));
    }
    const uri = p._meta && typeof p._meta === "object" ? object(p._meta)[MCP_APP_RESOURCE_META] : undefined;
    const rel = this.fromServer(owner, server, currentReferences(), uri),
      spec = JSON.parse(rel.spec) as AppSpec,
      t = spec.tools.find((t) => t.name === p.tool);
    if (!t) throw new Error("Unknown App tool");
    if (!compileSchema(t.inputSchema)(p.arguments))
      throw new Error("App tool arguments violate inputSchema");
    const data =
      t.handler.kind === "javascript"
        ? await javascript({
            source: t.handler.source,
            args: p.arguments,
            context: {
              appId: spec.appId,
              revision: rel.revision,
              tool: t.name,
            },
          })
        : t.handler.kind === "echo"
          ? p.arguments
          : t.handler.structuredContent;
    this.current(assertCurrent);
    const current = this.fromServer(owner, server, currentReferences(), rel.uri);
    if (current.owner !== rel.owner || current.revision !== rel.revision) throw new Error("App release is inactive");
    const wrapped =
      data && typeof data === "object" && "structuredContent" in data
        ? (data as { structuredContent: unknown; text?: string })
        : null;
    const content = wrapped ? wrapped.structuredContent : data;
    if (t.outputSchema && !compileSchema(t.outputSchema)(content))
      throw new Error("App output violates outputSchema");
    const encoded = JSON.stringify(content);
    if (
      Buffer.byteLength(encoded) > 131072 ||
      (typeof wrapped?.text === "string" &&
        Buffer.byteLength(wrapped.text) > 131072)
    )
      throw new Error("App output exceeds 128 KiB");
    return result(
      content,
      typeof wrapped?.text === "string" ? wrapped.text : undefined,
    );
  }
}
