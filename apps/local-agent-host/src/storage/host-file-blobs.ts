import { join, resolve } from "node:path";
import { validateBlobKey, type BlobStore } from "@opencraft/blob-storage";
import { fileBlobStore } from "@opencraft/blob-storage/file";

/**
 * Immutable objects that local execution also reads by host path. Engines and
 * the AttachmentRef `host-file` location consume paths, so only a backend that
 * keeps each committed key as a host file can serve this Host.
 */
export interface HostFileBlobStore {
  readonly blobs: BlobStore;
  /** Host file of a committed key. Not a staging location: uncommitted bytes are never there. */
  path(key: string): string;
}

/** `fileBlobStore(root)` keeps key `a/b` at `root/a/b`, so existing files stay where they are. */
export function hostFileBlobStore(root: string): HostFileBlobStore {
  const directory = resolve(root);
  return {
    blobs: fileBlobStore(directory),
    path(key) {
      validateBlobKey(key);
      return join(directory, key);
    },
  };
}
