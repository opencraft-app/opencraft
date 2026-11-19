import {
  parseWorkspaceResource,
  type WorkspaceDraft,
  type WorkspaceResourceLocation,
} from "./workspace-resource-model";
export interface WorkspaceDocument {
  readonly path: string;
  readonly baseText: string | null;
  readonly draft: WorkspaceDraft | null;
  readonly saving: boolean;
  readonly error: "conflict" | "write" | null;
}
export interface WorkspaceBrowserSession {
  location: WorkspaceResourceLocation;
  treeOpen: boolean;
  wrapLines: boolean;
  readonly directories: Map<string, { query: string; top: number }>;
  query: string;
  editing: Set<string>;
  source: string | null;
  expanded: ReadonlySet<string> | null;
  activePath: string;
  scrollTop: number;
  readonly views: Map<string, unknown>;
  readonly visited: Set<string>;
}
interface Scope {
  documents: Map<string, WorkspaceDocument>;
  browsers: Map<string, WorkspaceBrowserSession>;
  listeners: Set<() => void>;
  revision: number;
  alive: boolean;
}
/** Application-owned sessions; never a second directory or Blob cache. */
export class WorkspaceSessions {
  private scopes = new Map<string, Scope>();
  private scope(ownerId: string, hostId: string): Scope {
    const key = JSON.stringify([ownerId, hostId]);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { documents: new Map(), browsers: new Map(), listeners: new Set(), revision: 0, alive: true };
      this.scopes.set(key, scope);
    }
    return scope;
  }
  browser(ownerId: string, hostId: string, tabId: string, resource: string): WorkspaceBrowserSession {
    const scope = this.scope(ownerId, hostId);
    let browser = scope.browsers.get(tabId);
    if (!browser) {
      const location = parseWorkspaceResource(resource);
      browser = {
        location,
        treeOpen: false,
        wrapLines: false,
        directories: new Map(),
        query: "",
        editing: new Set(),
        source: location.line ? location.path : null,
        expanded: null,
        activePath: location.path,
        scrollTop: 0,
        views: new Map(),
        visited: new Set([location.path]),
      };
      scope.browsers.set(tabId, browser);
    }
    return browser;
  }
  revision(ownerId: string, hostId: string) {
    return this.scope(ownerId, hostId).revision;
  }
  subscribe(ownerId: string, hostId: string, listener: () => void) {
    const scope = this.scope(ownerId, hostId);
    scope.listeners.add(listener);
    return () => {
      scope.listeners.delete(listener);
    };
  }
  private publish(scope: Scope) {
    if (!scope.alive) return;
    scope.revision++;
    for (const listener of scope.listeners) listener();
  }
  changed(ownerId: string, hostId: string) {
    this.publish(this.scope(ownerId, hostId));
  }
  document(ownerId: string, hostId: string, path: string) {
    return this.scope(ownerId, hostId).documents.get(path);
  }
  observe(ownerId: string, hostId: string, path: string, text: string) {
    const scope = this.scope(ownerId, hostId),
      previous = scope.documents.get(path);
    if (previous?.baseText === text) return;
    scope.documents.set(path, {
      path,
      baseText: text,
      draft: previous?.draft ?? null,
      saving: previous?.saving ?? false,
      error: previous?.error ?? null,
    });
    const visible = new Set([...scope.browsers.values()].map((browser) => browser.location.path));
    const clean = [...scope.documents.values()].filter((doc) => !doc.draft && !doc.saving && !visible.has(doc.path));
    for (const old of clean.slice(0, Math.max(0, clean.length - 16))) scope.documents.delete(old.path);
    this.publish(scope);
  }
  edit(ownerId: string, hostId: string, path: string, text: string) {
    const scope = this.scope(ownerId, hostId),
      doc = scope.documents.get(path);
    if (!doc || doc.baseText === null) return;
    const baseText = doc.draft?.baseText ?? doc.baseText;
    scope.documents.set(path, { ...doc, draft: text === baseText ? null : { baseText, text }, error: null });
    this.publish(scope);
  }
  discard(ownerId: string, hostId: string, path: string) {
    const scope = this.scope(ownerId, hostId),
      doc = scope.documents.get(path);
    if (!doc || doc.saving) return;
    scope.documents.set(path, { ...doc, draft: null, error: null });
    this.publish(scope);
  }
  dirtyPaths(ownerId: string, hostId: string, tabId: string): string[] {
    const scope = this.scope(ownerId, hostId),
      browser = scope.browsers.get(tabId);
    return [...scope.documents.values()]
      .filter((doc) => browser?.visited.has(doc.path) && (doc.draft || doc.saving))
      .map((doc) => doc.path);
  }
  async save(
    ownerId: string,
    hostId: string,
    path: string,
    read: () => Promise<string | null>,
    write: (text: string) => Promise<void>,
  ): Promise<void> {
    const scope = this.scope(ownerId, hostId),
      doc = scope.documents.get(path);
    if (!doc?.draft || doc.saving) return;
    const submitted = doc.draft;
    scope.documents.set(path, { ...doc, saving: true, error: null });
    this.publish(scope);
    let failure: WorkspaceDocument["error"] = "write";
    try {
      // No conditional-write capability exists yet. This narrows, but cannot eliminate, the external-write race.
      const current = await read();
      if (!scope.alive) return;
      if (current !== submitted.baseText) {
        failure = "conflict";
        scope.documents.set(path, { ...scope.documents.get(path)!, baseText: current });
        throw new Error("Workspace file conflict");
      }
      await write(submitted.text);
      if (!scope.alive) return;
      const latest = scope.documents.get(path)!;
      scope.documents.set(path, {
        ...latest,
        baseText: submitted.text,
        saving: false,
        error: null,
        draft:
          latest.draft?.text === submitted.text
            ? null
            : { baseText: submitted.text, text: latest.draft?.text ?? submitted.baseText },
      });
    } catch (error) {
      if (scope.alive) scope.documents.set(path, { ...scope.documents.get(path)!, saving: false, error: failure });
      throw error;
    } finally {
      this.publish(scope);
    }
  }
  releaseTab(ownerId: string, tabId: string) {
    for (const [key, scope] of this.scopes) {
      if (JSON.parse(key)[0] !== ownerId) continue;
      scope.browsers.delete(tabId);
      if (scope.browsers.size === 0) {
        scope.alive = false;
        scope.listeners.clear();
        this.scopes.delete(key);
      } else {
        const retained = new Set([...scope.browsers.values()].flatMap((browser) => [...browser.visited]));
        for (const path of scope.documents.keys()) if (!retained.has(path)) scope.documents.delete(path);
      }
    }
  }
  dispose() {
    for (const scope of this.scopes.values()) {
      scope.alive = false;
      scope.listeners.clear();
    }
    this.scopes.clear();
  }
}
export function workspaceLocationResource(location: WorkspaceResourceLocation): string {
  const path = location.path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
    .replace(/^([A-Za-z])%3A\//u, "$1:/");
  return `file://${path.startsWith("/") ? "" : "/"}${path}${location.line ? `#L${location.line}${location.column ? `C${location.column}` : ""}` : ""}`;
}
