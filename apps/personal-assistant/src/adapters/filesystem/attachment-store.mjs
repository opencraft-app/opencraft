import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
  fsyncSync,
  mkdirSync,
  linkSync,
  unlinkSync,
  opendirSync,
  lstatSync,
} from "node:fs";
import { join, basename, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { digest, stable } from "../../domain/values.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function readRegular(path, max = MAX_BYTES) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max)
      throw new Error("Attachment is not a bounded regular file");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    let size = 0,
      n;
    while (
      size < buffer.length &&
      (n = readSync(fd, buffer, size, buffer.length - size, null)) > 0
    )
      size += n;
    if (size !== stat.size || size > max || fstatSync(fd).size !== stat.size)
      throw new Error("Attachment changed during read");
    return buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
    throw new Error("Unsafe attachment directory");
}
function writeOnce(path, bytes, maxBytes = MAX_BYTES) {
  const temporary = `${path}.${randomUUID()}.tmp`,
    fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!readRegular(path, maxBytes + 8192).equals(bytes))
      throw new Error("Attachment identity contains different bytes");
  } finally {
    unlinkSync(temporary);
  }
}
const mimeFor = (name) =>
  ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
  })[extname(name).toLowerCase()] ?? "application/octet-stream";

/** Immutable profile-local attachments. Models get IDs, never a path/URL import capability. */
export class LocalAttachmentStore {
  constructor(root, { maxBytes = MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw Error('Invalid attachment size bound');
    this.maxBytes = maxBytes;
    this.root = root;
    directory(root);
  }
  importFile(path) {
    return this.importBytes(basename(path), readRegular(path, this.maxBytes));
  }
  importBytes(name, bytes) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 160 ||
      name.includes("/") ||
      name.includes("\\") ||
      /[\x00-\x1f]/.test(name)
    )
      throw new Error("Invalid attachment name");
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxBytes)
      throw new Error(`Attachment exceeds ${this.maxBytes / 1024 / 1024} MiB`);
    const facts = {
      name,
      mimeType: mimeFor(name),
      size: bytes.length,
      sha256: sha(bytes),
    };
    const id = digest(facts);
    writeOnce(join(this.root, `${id}.blob`), bytes, this.maxBytes);
    writeOnce(join(this.root, `${id}.json`), Buffer.from(stable(facts)));
    const fd = openSync(this.root, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { attachmentId: id, ...facts };
  }
  describe(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid attachment ID");
    const facts = JSON.parse(
      readRegular(join(this.root, `${id}.json`), 4096).toString("utf8"),
    );
    if (
      digest(facts) !== id ||
      typeof facts.name !== "string" ||
      !Number.isSafeInteger(facts.size) ||
      facts.size < 0 ||
      facts.size > this.maxBytes ||
      !/^[a-f0-9]{64}$/.test(facts.sha256)
    )
      throw new Error("Attachment metadata mismatch");
    return { attachmentId: id, ...facts };
  }
  read(id) {
    const facts = this.describe(id),
      bytes = readRegular(join(this.root, `${id}.blob`), this.maxBytes);
    if (bytes.length !== facts.size || sha(bytes) !== facts.sha256)
      throw new Error("Attachment bytes no longer match their identity");
    return { facts, bytes };
  }
  list({ after = "", limit = 12 } = {}) {
    if (
      typeof after !== "string" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error("Invalid attachment page");
    const ids = [],
      dir = opendirSync(this.root);
    let entry,
      count = 0;
    try {
      while ((entry = dir.readSync())) {
        if (++count > 8192) throw new Error("Attachment catalog exceeds bound");
        if (
          /^[a-f0-9]{64}\.json$/.test(entry.name) &&
          entry.name.slice(0, -5) > after
        )
          ids.push(entry.name.slice(0, -5));
      }
    } finally {
      dir.closeSync();
    }
    ids.sort();
    return {
      items: ids.slice(0, limit).map((id) => this.describe(id)),
      next: ids.length > limit ? ids[limit - 1] : null,
    };
  }
  materialize(id, target) {
    const { facts, bytes } = this.read(id);
    directory(target);
    const path = `${id}.blob`;
    writeOnce(join(target, path), bytes, this.maxBytes);
    const fd = openSync(target, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { ...facts, path: `assets/${path}` };
  }
}
