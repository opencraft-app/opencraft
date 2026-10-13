import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import type { BlobResourceService } from "@opencraft/blob-resources";

let blobs: BlobResourceService;
const reads: string[] = [];
const runtime = { resources: {
  host: { canRequest: () => false },
  fileSystem: {
    async getMetadata() { return { isFile: true, isDirectory: false, modifiedAtMs: 0 }; },
    async readFile(path: string, signal: AbortSignal) {
      reads.push(path);
      const response = await fetch(path, { signal });
      if (!response.ok) throw new Error("Fixture unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { dataBase64: btoa(binary) };
    },
  },
} } as unknown as AppServerWorkbenchRuntime;

export function setMediaFixtureBlobs(service: BlobResourceService) { blobs = service; }
export function useBlobResources() { return blobs; }
export function useAppServerRuntime() { return runtime; }
export function useAppServerSnapshot() { return { hostId: "media-fixture", conversation: null }; }
export function mediaFixtureReads() { return [...reads]; }
