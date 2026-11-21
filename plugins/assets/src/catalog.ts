import { assetSource, type AssetSource, type SandboxConfigurationsSnapshot } from "./contract";

/** Public metadata only. Never accept a private credential projection into UI state. */
export function parseAssetCatalog(value: unknown, scope: string): SandboxConfigurationsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid");
  const v = value as Record<string, unknown>;
  const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 1024;
  if (
    v.scope !== scope ||
    !Number.isSafeInteger(v.revision) ||
    (v.revision as number) < 0 ||
    typeof v.allowCustomEndpoints !== "boolean" ||
    !Array.isArray(v.credentials) ||
    v.credentials.length > 64 ||
    !Array.isArray(v.environments) ||
    v.environments.length > 64
  )
    throw Error("invalid");
  if (
    (v.canManagePlatform !== undefined && typeof v.canManagePlatform !== "boolean") ||
    (v.platformRevision !== undefined &&
      (!Number.isSafeInteger(v.platformRevision) || (v.platformRevision as number) < 0))
  )
    throw Error("invalid");
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  function sourceFields(item: { source?: unknown; id: string }, credential = false): { source?: AssetSource } {
    if (item.source !== undefined && item.source !== "personal" && item.source !== "platform") throw Error("invalid");
    const source = item.source ?? "personal";
    if (source === "platform" && (v.platformRevision === undefined || (credential && v.canManagePlatform !== true)))
      throw Error("invalid");
    const key = `${source}:${item.id}`;
    if (ids.has(key)) throw Error("invalid");
    ids.add(key);
    const count = (counts.get(source) ?? 0) + 1;
    if (count > 32) throw Error("invalid");
    counts.set(source, count);
    return item.source === undefined ? {} : { source: item.source };
  }
  const credentials = v.credentials.map((c) => {
    if (
      !c ||
      typeof c !== "object" ||
      ![c.id, c.name, c.apiUrl, c.sandboxUrl, c.generation].every(text) ||
      Object.hasOwn(c, "apiKey")
    )
      throw Error("invalid");
    const source = sourceFields(c, true);
    return {
      ...source,
      id: c.id,
      name: c.name,
      apiUrl: c.apiUrl,
      sandboxUrl: c.sandboxUrl,
      generation: c.generation,
    };
  });
  ids.clear();
  counts.clear();
  const environments = v.environments.map((e) => {
    if (
      !e ||
      typeof e !== "object" ||
      ![e.id, e.name, e.templateId].every(text) ||
      (!text(e.credentialId) &&
        !(e.credentialId === undefined && e.source === "platform" && v.canManagePlatform === false))
    )
      throw Error("invalid");
    if (e.source === "platform" && v.canManagePlatform === false && e.credentialId !== undefined)
      throw Error("invalid");
    const source = sourceFields(e);
    return {
      ...source,
      id: e.id,
      name: e.name,
      ...(e.credentialId !== undefined ? { credentialId: e.credentialId } : {}),
      templateId: e.templateId,
    };
  });
  const libraries =
    v.libraries === undefined
      ? undefined
      : (() => {
          if (
            !Number.isSafeInteger(v.libraryRevision) ||
            (v.libraryRevision as number) < 0 ||
            !Array.isArray(v.libraries) ||
            v.libraries.length > 32
          )
            throw Error("invalid");
          const seen = new Set<string>();
          return v.libraries.map((l) => {
            if (
              !l ||
              typeof l !== "object" ||
              !text(l.id) ||
              !text(l.name) ||
              seen.has(l.id) ||
              l.source !== "platform" ||
              l.kind !== "nfs" ||
              l.managedBy !== "e2b" ||
              l.mountPath !== "/shared" ||
              !text(l.verifiedAt) ||
              !Number.isFinite(Date.parse(l.verifiedAt)) ||
              !["configured", "unavailable"].includes(l.status) ||
              !Array.isArray(l.environmentIds) ||
              l.environmentIds.length > 32 ||
              !l.environmentIds.every(
                (id: unknown) =>
                  typeof id === "string" && environments.some((e) => e.id === id && e.source === "platform"),
              )
            )
              throw Error("invalid");
            seen.add(l.id);
            return {
              id: l.id,
              name: l.name,
              kind: "nfs" as const,
              managedBy: "e2b" as const,
              mountPath: "/shared" as const,
              source: "platform" as const,
              verifiedAt: l.verifiedAt,
              status: l.status as "configured" | "unavailable",
              environmentIds: [...l.environmentIds] as string[],
            };
          });
        })();
  return {
    ...(libraries ? { libraries, libraryRevision: v.libraryRevision as number } : {}),
    scope,
    revision: v.revision as number,
    allowCustomEndpoints: v.allowCustomEndpoints,
    ...(v.canManagePlatform !== undefined ? { canManagePlatform: v.canManagePlatform as boolean } : {}),
    ...(v.platformRevision !== undefined ? { platformRevision: v.platformRevision as number } : {}),
    credentials,
    environments,
  };
}

/** Duplicate names stay selectable without exposing endpoints or internal identifiers. */
export function connectionLabel(
  connection: SandboxConfigurationsSnapshot["credentials"][number],
  connections: SandboxConfigurationsSnapshot["credentials"],
): string {
  if (connections.filter((item) => item.name === connection.name).length < 2) return connection.name;
  const siblings = connections.filter((item) => item.name === connection.name);
  return `${connection.name} (${siblings.findIndex((item) => item.id === connection.id && assetSource(item) === assetSource(connection)) + 1})`;
}

/** Independent custody documents have independent CAS clocks; never rebase a draft. */
export const catalogRevision = (snapshot: SandboxConfigurationsSnapshot, source: AssetSource): number =>
  source === "platform" ? (snapshot.platformRevision ?? 0) : snapshot.revision;
export function mergeAssetCatalog(
  previous: SandboxConfigurationsSnapshot | undefined,
  next: SandboxConfigurationsSnapshot,
): SandboxConfigurationsSnapshot {
  if (!previous || previous.scope !== next.scope) return next;
  const records = (kind: "credentials" | "environments") =>
    (["personal", "platform"] as const).flatMap((source) => {
      if (source === "platform" && kind === "credentials" && !next.canManagePlatform) return [];
      const chosen = catalogRevision(previous, source) > catalogRevision(next, source) ? previous : next;
      return chosen[kind]
        .filter((item) => assetSource(item) === source)
        .map((item) => {
          if (kind === "environments" && source === "platform" && !next.canManagePlatform) {
            const { credentialId: _credentialId, ...publicItem } =
              item as SandboxConfigurationsSnapshot["environments"][number];
            return publicItem;
          }
          return item;
        });
    });
  return {
    ...next,
    revision: Math.max(previous.revision, next.revision),
    ...(next.libraryRevision !== undefined &&
    previous.libraryRevision !== undefined &&
    previous.libraryRevision > next.libraryRevision
      ? {
          libraryRevision: previous.libraryRevision,
          libraries: previous.libraries
            ?.map((l) => ({
              ...l,
              environmentIds: l.environmentIds.filter((id) =>
                next.environments.some((e) => e.id === id && e.source === "platform"),
              ),
            }))
            .map((l) => ({
              ...l,
              status: l.environmentIds.length ? ("configured" as const) : ("unavailable" as const),
            })),
        }
      : {}),
    ...(next.platformRevision !== undefined
      ? {
          platformRevision: Math.max(previous.platformRevision ?? 0, next.platformRevision),
        }
      : {}),
    credentials: records("credentials") as SandboxConfigurationsSnapshot["credentials"],
    environments: records("environments") as SandboxConfigurationsSnapshot["environments"],
  };
}
