import { digest } from "../domain/values.mjs";
import { memoryDocument } from "../domain/memory-recall.mjs";

export class MemoryBrowserError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export function memoryBrowserFailure(error) {
  const known = [
    "conflict",
    "snapshot_changed",
    "document_changed",
    "offline",
    "not_provisioned",
    "busy",
    "recovery_required",
    "storage",
    "duplicate",
    "invalid",
    "entry_missing",
  ];
  if (known.includes(error?.code)) return { action: "error", code: error.code };
  const message = error?.message ?? "";
  const code = /Stale memory revision/.test(message)
    ? "conflict"
    : /content already exists/.test(message)
      ? "duplicate"
      : error?.code === "MEMORY_BUSY"
        ? "busy"
        : /memory.*changed|memory.*conflict/i.test(message)
          ? "snapshot_changed"
          : /Private memory unavailable/.test(message)
            ? "entry_missing"
            : "storage";
  return { action: "error", code };
}
export function validateMemoryBrowser(raw) {
  const actions = {
    list: ["query", "after", "kind"],
    documents: ["after"],
    status: [],
    entry: ["key"],
    file: ["path", "offset", "version"],
    sources: ["key"],
    set: ["key", "value", "expectedRevision", "requestId"],
    forget: ["key", "expectedRevision", "requestId"],
  };
  const fail = () => {
    throw new MemoryBrowserError("invalid");
  };
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !Object.hasOwn(actions, raw.action) ||
    Object.keys(raw).some(
      (k) => k !== "action" && !actions[raw.action].includes(k),
    )
  )
    fail();
  if (
    raw.query !== undefined &&
    (typeof raw.query !== "string" || raw.query.length > 200)
  )
    fail();
  if (raw.kind !== undefined && !["profile", "log"].includes(raw.kind)) fail();
  if (
    raw.after !== undefined &&
    (typeof raw.after !== "string" || raw.after.length > 512)
  )
    fail();
  if (
    ["entry", "sources", "set", "forget"].includes(raw.action) &&
    (typeof raw.key !== "string" || !raw.key || raw.key.length > 160)
  )
    fail();
  if (
    raw.action === "file" &&
    (typeof raw.path !== "string" ||
      !/^(profile\.md|log\/\d{4}-(0[1-9]|1[0-2])\.md)$/.test(raw.path) ||
      !Number.isSafeInteger(raw.offset ?? 0) ||
      (raw.offset ?? 0) < 0 ||
      (raw.version !== undefined && typeof raw.version !== "string"))
  )
    fail();
  if (
    ["set", "forget"].includes(raw.action) &&
    (!Number.isSafeInteger(raw.expectedRevision) ||
      raw.expectedRevision < 1 ||
      typeof raw.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(raw.requestId))
  )
    fail();
  if (
    raw.action === "set" &&
    (typeof raw.value !== "string" ||
      !raw.value.trim() ||
      raw.value.length > 500)
  )
    fail();
  return { ...raw };
}
export function createMemoryBrowserView({ rows, images, directory, writable }) {
  const items = rows
    .filter((r) => !r.deleted && r.scope === "agent")
    .map((r) => ({
      key: r.key,
      value: r.value,
      revision: r.revision,
      kind: r.kind,
      updatedAt: r.updatedAt ?? 0,
      origin: r.origin ?? "legacy",
      evidenceIds: (r.evidenceIds ?? []).slice(0, 8),
      document: memoryDocument(r),
    }))
    .sort(
      (a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key, "en"),
    );
  const files = new Map();
  for (const [path, text] of images) {
    const relative = path.startsWith(directory + "/")
      ? path.slice(directory.length + 1)
      : "";
    if (
      text !== null &&
      /^(profile\.md|log\/\d{4}-(0[1-9]|1[0-2])\.md)$/.test(relative)
    )
      files.set(relative, text);
  }
  const documents = [...files]
    .map(([path, text]) => ({
      path,
      kind: path === "profile.md" ? "profile" : "log",
      characters: text.length,
      facts: items.filter((r) => r.document?.path === path).length,
      version: digest(text),
    }))
    .sort((a, b) =>
      a.path === "profile.md"
        ? -1
        : b.path === "profile.md"
          ? 1
          : b.path.localeCompare(a.path),
    );
  const version = digest({ items, documents });
  return { items, files, documents, version, writable };
}
function page(rows, after, identity) {
  let start = 0;
  if (after !== undefined) {
    let cursor;
    try {
      cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
    } catch {
      throw new MemoryBrowserError("invalid");
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 2 ||
      typeof cursor[0] !== "string" ||
      !Number.isSafeInteger(cursor[1]) ||
      cursor[1] < 1
    )
      throw new MemoryBrowserError("invalid");
    if (cursor[0] !== identity)
      throw new MemoryBrowserError("snapshot_changed");
    start = cursor[1];
    if (start > rows.length) throw new MemoryBrowserError("invalid");
  }
  return {
    items: rows.slice(start, start + 30),
    next:
      start + 30 < rows.length
        ? Buffer.from(JSON.stringify([identity, start + 30])).toString(
            "base64url",
          )
        : null,
    total: rows.length,
  };
}
export function readMemoryBrowser(view, p, evidence) {
  const common = { version: view.version, writable: view.writable };
  if (p.action === "status")
    return { action: p.action, ...common, total: view.items.length };
  if (p.action === "list") {
    const q = (p.query ?? "").trim().toLowerCase(),
      rows = view.items.filter(
        (r) =>
          (!p.kind || p.kind === r.kind) &&
          (!q || (r.key + " " + r.value).toLowerCase().includes(q)),
      );
    return {
      action: p.action,
      ...common,
      ...page(rows, p.after, digest([view.version, q, p.kind ?? null])),
    };
  }
  if (p.action === "documents")
    return {
      action: p.action,
      ...common,
      ...page(view.documents, p.after, digest([view.version, "documents"])),
    };
  if (p.action === "file") {
    const text = view.files.get(p.path);
    if (text === undefined) throw new MemoryBrowserError("entry_missing");
    const version = digest(text),
      offset = p.offset ?? 0;
    if (offset > 0 && p.version !== version)
      throw new MemoryBrowserError("document_changed");
    if (offset > text.length) throw new MemoryBrowserError("invalid");
    return {
      action: p.action,
      content: text.slice(offset, offset + 8000),
      path: p.path,
      exists: true,
      version,
      nextOffset: offset + 8000 < text.length ? offset + 8000 : null,
    };
  }
  const item = view.items.find((r) => r.key === p.key);
  if (p.action === "entry")
    return { action: p.action, ...common, item: item ?? null };
  if (p.action === "sources") {
    if (!item) throw new MemoryBrowserError("entry_missing");
    return { action: p.action, item, sources: evidence(item.evidenceIds) };
  }
  throw new MemoryBrowserError("invalid");
}
