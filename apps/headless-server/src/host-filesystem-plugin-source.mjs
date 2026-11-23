import { createVfsPluginSource } from "@opencraft/runtime-plugin-host/source";
import { createHostFileSystem } from "./host-filesystem.js";

/**
 * Runtime plugin byte source over the Hands host-filesystem RPC (`fs/readFile`).
 *
 * The source only reads the files listed by an administrator-pinned selection under
 * `root/packages/<id>/<revision>`; `createVfsPluginSource` re-verifies every digest and
 * the loader imports from a private snapshot. It discovers no plugins, starts no
 * process and changes no permission on the file owner's side. `close()` releases the
 * RPC client.
 *
 * @param {{ root: string, endpoint: string, tokenFile: string }} options
 */
export function createHostFileSystemPluginSource({ root, endpoint, tokenFile }) {
  const files = createHostFileSystem({ endpoint, tokenFile });
  try {
    return source(root, files);
  } catch (error) {
    files.close();
    throw error;
  }
}

function source(root, files) {
  return createVfsPluginSource({
    root,
    close: () => files.close(),
    async readFile(path, { signal, maxBytes }) {
      const value = await files.request("fs/readFile", { path }, signal);
      const encoded = value?.dataBase64;
      // Reject oversized payloads before decoding them.
      if (typeof encoded !== "string" || encoded.length > Math.ceil(maxBytes / 3) * 4)
        throw Error("Plugin source file exceeds its budget");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length > maxBytes || bytes.toString("base64") !== encoded) throw Error("Invalid plugin source bytes");
      return bytes;
    },
  });
}
