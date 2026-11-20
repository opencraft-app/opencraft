import {
  realpathSync,
  lstatSync,
  readdirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
} from "node:fs";
import { resolve, relative, isAbsolute, extname, join } from "node:path";
import { digest } from "../../domain/values.mjs";

/** Operator-selected, read-only materials. The model cannot choose its own root. */
export class DirectoryKnowledgeSource {
  constructor(directory) {
    this.root = realpathSync(directory);
    this.binding = digest(this.root);
  }
  reference() {
    return { id: "materials", binding: this.binding };
  }
  resolve(path = "") {
    if (typeof path !== "string" || path.includes("\0") || isAbsolute(path))
      throw new Error("Material path must be relative");
    const segments = path.split(/[\\/]/);
    if (segments.some((s) => s === ".." || s.startsWith(".")))
      throw new Error("Material path is outside the allowed scope");
    const resolved = resolve(this.root, path),
      rel = relative(this.root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Material path escapes the configured source");
    let at = this.root;
    for (const segment of segments.filter(Boolean)) {
      at = join(at, segment);
      if (lstatSync(at).isSymbolicLink())
        throw new Error("Material symlinks are not followed");
    }
    return resolved;
  }
  list(directory = "") {
    const path = this.resolve(directory),
      files = [];
    for (const entry of readdirSync(path, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 1000)) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const item = join(directory, entry.name);
      if (entry.isDirectory()) files.push({ path: item, type: "directory" });
      else if (this.supported(item) && entry.isFile())
        files.push({
          path: item,
          type: "file",
          bytes: lstatSync(join(path, entry.name)).size,
        });
      if (files.length >= 100) break;
    }
    return files;
  }
  supported(path) {
    return [".md", ".txt", ".json", ".csv", ".log"].includes(
      extname(path).toLowerCase(),
    );
  }
  read(path) {
    if (!this.supported(path)) throw new Error("Unsupported material format");
    if (process.platform !== "linux")
      throw new Error(
        "This source adapter currently requires Linux descriptor verification",
      );
    const fd = openSync(
      this.resolve(path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = realpathSync(`/proc/self/fd/${fd}`),
        rel = relative(this.root, opened);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Opened material escaped the configured source");
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536)
        throw new Error(
          "Material must be a regular file no larger than 64 KiB",
        );
      const bytes = Buffer.alloc(65537);
      let size = 0,
        n;
      while (
        size < bytes.length &&
        (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0
      )
        size += n;
      if (size > 65536) throw new Error("Material grew beyond the size limit");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, size),
      );
      return {
        source: "materials",
        path: rel,
        text,
        sha256: digest(text),
        bytes: size,
      };
    } finally {
      closeSync(fd);
    }
  }
}
