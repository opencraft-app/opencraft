import { Service } from "@deepseek-ai/cordis";
import type { HypernodeContext } from "../types/context.js";
import type {
  MemoryVfsPort,
  VfsChangeListener,
  VfsDirectoryEntry,
  VfsDirectoryNode,
  VfsFileNode,
  VfsLookup,
  VfsMetadata,
  VfsNode,
} from "../types/vfs.js";

export class VfsError extends Error {
  readonly code: string;
  readonly path: string | null;

  constructor(code: string, path: string | null, message?: string) {
    super(message ?? `${code}: ${path ?? ""}`);
    this.code = code;
    this.path = path;
  }
}

export class MemoryVFS extends Service implements MemoryVfsPort {
  readonly nodes = new Map<string, VfsNode>();
  readonly changeListeners = new Set<VfsChangeListener>();
  now: () => number = () => Date.now();

  constructor(ctx: HypernodeContext) {
    super(ctx, "vfs");
    this.nodes.set("/", this.directoryNode());
  }

  normalize(path: string): string {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new VfsError("EINVAL", String(path), "VFS paths must be absolute");
    }
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) throw new VfsError("EINVAL", path, "path escapes the virtual root");
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    return `/${parts.join("/")}`;
  }

  parent(path: string): string | null {
    if (path === "/") return null;
    const offset = path.lastIndexOf("/");
    return offset === 0 ? "/" : path.slice(0, offset);
  }

  basename(path: string): string {
    return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  }

  private directoryNode(): VfsDirectoryNode {
    const now = this.now();
    return { type: "directory", createdAtMs: now, modifiedAtMs: now };
  }

  private fileNode(data: ArrayLike<number>): VfsFileNode {
    const now = this.now();
    return { type: "file", data: Array.from(data), createdAtMs: now, modifiedAtMs: now };
  }

  get(path: string): VfsLookup {
    const normalized = this.normalize(path);
    const node = this.nodes.get(normalized);
    if (!node) throw new VfsError("ENOENT", normalized);
    return { path: normalized, node };
  }

  metadata(path: string): VfsMetadata {
    const { node } = this.get(path);
    return {
      isDirectory: node.type === "directory",
      isFile: node.type === "file",
      isSymlink: false,
      createdAtMs: node.createdAtMs,
      modifiedAtMs: node.modifiedAtMs,
    };
  }

  onChange(listener: VfsChangeListener): () => boolean {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(paths: string[]): void {
    const normalized = [...new Set(paths.map((path) => this.normalize(path)))];
    for (const listener of this.changeListeners) listener(normalized);
  }

  createDirectory(path: string, recursive = true): void {
    const normalized = this.normalize(path);
    if (normalized === "/") return;
    const segments = normalized.slice(1).split("/");
    let current = "";
    const created: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      current += `/${segments[index] ?? ""}`;
      const existing = this.nodes.get(current);
      if (existing?.type === "file") throw new VfsError("ENOTDIR", current);
      if (!existing) {
        if (!recursive && index !== segments.length - 1) throw new VfsError("ENOENT", current);
        this.nodes.set(current, this.directoryNode());
        created.push(current);
      }
    }
    if (created.length > 0) this.changed(created);
  }

  writeFile(path: string, data: ArrayLike<number>): void {
    const normalized = this.normalize(path);
    const parent = this.parent(normalized);
    const parentNode = parent === null ? undefined : this.nodes.get(parent);
    if (!parentNode) throw new VfsError("ENOENT", parent);
    if (parentNode.type !== "directory") throw new VfsError("ENOTDIR", parent);
    const existing = this.nodes.get(normalized);
    if (existing?.type === "directory") throw new VfsError("EISDIR", normalized);
    const node = this.fileNode(data);
    if (existing) node.createdAtMs = existing.createdAtMs;
    this.nodes.set(normalized, node);
    parentNode.modifiedAtMs = this.now();
    this.changed([normalized]);
  }

  readFile(path: string): number[] {
    const { path: normalized, node } = this.get(path);
    if (node.type !== "file") throw new VfsError("EISDIR", normalized);
    return [...node.data];
  }

  readDirectory(path: string): VfsDirectoryEntry[] {
    const { path: normalized, node } = this.get(path);
    if (node.type !== "directory") throw new VfsError("ENOTDIR", normalized);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entries: VfsDirectoryEntry[] = [];
    for (const [candidate, child] of this.nodes) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      if (!remainder || remainder.includes("/")) continue;
      entries.push({
        fileName: remainder,
        isDirectory: child.type === "directory",
        isFile: child.type === "file",
      });
    }
    entries.sort((left, right) => left.fileName.localeCompare(right.fileName));
    return entries;
  }

  remove(path: string, recursive = true, force = true): void {
    const normalized = this.normalize(path);
    if (normalized === "/") throw new VfsError("EPERM", normalized, "cannot remove virtual root");
    let node: VfsNode;
    try {
      node = this.get(normalized).node;
    } catch (error) {
      if (force && error instanceof VfsError && error.code === "ENOENT") return;
      throw error;
    }
    const prefix = `${normalized}/`;
    const descendants = [...this.nodes.keys()].filter((candidate) => candidate.startsWith(prefix));
    if (node.type === "directory" && descendants.length > 0 && !recursive) {
      throw new VfsError("ENOTEMPTY", normalized);
    }
    for (const candidate of descendants) this.nodes.delete(candidate);
    this.nodes.delete(normalized);
    const parent = this.parent(normalized);
    const parentNode = parent === null ? undefined : this.nodes.get(parent);
    if (parentNode) parentNode.modifiedAtMs = this.now();
    this.changed([normalized]);
  }

  copy(sourcePath: string, destinationPath: string, recursive = false): void {
    const source = this.normalize(sourcePath);
    const destination = this.normalize(destinationPath);
    const { node } = this.get(source);
    if (source === destination || destination.startsWith(`${source}/`)) {
      throw new VfsError("EINVAL", destination, "cannot copy a directory into itself");
    }
    const destinationParent = this.parent(destination);
    const parentNode = destinationParent === null ? undefined : this.nodes.get(destinationParent);
    if (!parentNode) throw new VfsError("ENOENT", destinationParent);
    if (parentNode.type !== "directory") throw new VfsError("ENOTDIR", destinationParent);
    if (node.type === "file") {
      this.writeFile(destination, node.data);
      return;
    }
    if (!recursive) throw new VfsError("EINVAL", source, "directory copies require recursive: true");
    this.createDirectory(destination, false);
    const prefix = `${source}/`;
    const descendants = [...this.nodes.entries()]
      .filter(([candidate]) => candidate.startsWith(prefix))
      .sort(([left], [right]) => left.length - right.length);
    for (const [candidate, child] of descendants) {
      const target = `${destination}/${candidate.slice(prefix.length)}`;
      if (child.type === "directory") this.createDirectory(target, true);
      else this.writeFile(target, child.data);
    }
  }
}
