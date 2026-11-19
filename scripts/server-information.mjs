import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export const SERVER_INFORMATION_PATH = "/__opencraft_server_information";
/** A link destination, never an authentication origin, proxy route or fetch target. */
export function normalizePublicEntry(value) {
  if (typeof value !== "string" || value.length > 2048) throw Error("invalid_public_url");
  const text = value.trim();
  if (!text) return "";
  if (!/^https?:\/\//iu.test(text) || /[\s\\\x00-\x1f\x7f]/u.test(text)) throw Error("invalid_public_url");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw Error("invalid_public_url");
  }
  if (
    url.username ||
    url.password ||
    text.includes("?") ||
    text.includes("#") ||
    !url.hostname ||
    !url.pathname
      .slice(1)
      .split("/")
      .every(
        (segment, index, segments) =>
          /^[A-Za-z0-9._~-]*$/u.test(segment) && (segment.length > 0 || index === segments.length - 1),
      ) ||
    text
      .replace(/^https?:\/\/[^/]+/iu, "")
      .split("/")
      .some((s) => s === "." || s === "..")
  )
    throw Error("invalid_public_url");
  let end = url.pathname.length;
  while (end > 0 && url.pathname[end - 1] === "/") end--;
  return url.origin + url.pathname.slice(0, end);
}

/** One independently persisted server setting, not a per-browser subscription preference. */
export class ServerInformationStore {
  constructor(path) {
    this.path = path;
  }
  async read() {
    let value;
    try {
      value = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { revision: 0, publicUrl: "" };
      throw Error("server_information_unavailable");
    }
    if (
      value?.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      typeof value.updatedBy !== "string" ||
      !Number.isSafeInteger(value.updatedAt)
    )
      throw Error("server_information_unavailable");
    try {
      return { revision: value.revision, publicUrl: normalizePublicEntry(value.publicUrl) };
    } catch {
      throw Error("server_information_unavailable");
    }
  }
  async write(revision, publicUrl, actorId, assertCurrent) {
    const normalized = normalizePublicEntry(publicUrl);
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof actorId !== "string" || !actorId)
      throw Error("invalid_server_information");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let release;
    try {
      release = await lockfile.lock(this.path, { realpath: false, retries: 0 });
    } catch (error) {
      if (error.code === "ELOCKED") throw Error("revision_conflict");
      throw Error("server_information_unavailable");
    }
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      const previous = await this.read();
      if (previous.revision !== revision) throw Error("revision_conflict");
      const next = {
        schemaVersion: 1,
        revision: revision + 1,
        publicUrl: normalized,
        updatedBy: actorId,
        updatedAt: Date.now(),
      };
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(next) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      // Recheck after lock and filesystem awaits, immediately before the commit boundary.
      assertCurrent();
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { revision: next.revision, publicUrl: normalized };
    } finally {
      try {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      } finally {
        await release();
      }
    }
  }
}

export function serverInformationHttp(store, authority) {
  return async (request, response) => {
    if (new URL(request.url ?? "/", "http://information.invalid").pathname !== SERVER_INFORMATION_PATH) return false;
    const send = (status, value) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const access = authority(request);
      if (!access) {
        send(401, { error: "human_authentication_required" });
        return true;
      }
      const current = () => {
        const latest = authority(request);
        if (!latest || latest.actorId !== access.actorId) throw Error("account_changed");
        return latest;
      };
      if (request.method === "GET") {
        const value = await store.read(),
          latest = current();
        send(200, { ...value, actorId: latest.actorId, canManage: latest.administrator });
        return true;
      }
      if (request.method !== "POST") {
        send(405, { error: "method_not_allowed" });
        return true;
      }
      if (!access.administrator) {
        send(403, { error: "administrator_required" });
        return true;
      }
      const origin = request.headers.origin;
      if (
        typeof origin !== "string" ||
        !(origin === access.origin || ["http:", "https:"].some((p) => origin === p + "//" + request.headers.host)) ||
        request.headers["sec-fetch-site"] === "cross-site" ||
        request.headers["content-type"]?.split(";")[0] !== "application/json"
      ) {
        send(403, { error: "same_origin_required" });
        return true;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 4096) {
          send(413, { error: "too_large" });
          return true;
        }
        chunks.push(Buffer.from(chunk));
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw Error("invalid_server_information");
      }
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((k) => !["revision", "publicUrl", "expectedActorId"].includes(k))
      )
        throw Error("invalid_server_information");
      if (input.expectedActorId !== access.actorId) throw Error("account_changed");
      const value = await store.write(input.revision, input.publicUrl, access.actorId, () => {
        if (!current().administrator) throw Error("administrator_required");
      });
      const latest = current();
      send(200, { ...value, actorId: latest.actorId, canManage: latest.administrator });
    } catch (error) {
      const code = error?.message;
      const status =
        code === "revision_conflict" || code === "account_changed"
          ? 409
          : code === "administrator_required"
            ? 403
            : code === "invalid_public_url" || code === "invalid_server_information"
              ? 400
              : 503;
      send(status, { error: status === 503 ? "server_information_unavailable" : code });
    }
    return true;
  };
}
