import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import type { BlobResourceService } from "@opencraft/blob-resources";

let blobs: BlobResourceService;
const reads: string[] = [];
type SearchOptions = Parameters<AppServerWorkbenchRuntime["resources"]["fileSystem"]["createFuzzyFileSearchSession"]>[0];
const searches: { queries: string[]; stops: number; release(): void }[] = [];
export function mediaFixtureSearches() { return searches.map(({ queries, stops }) => ({ queries: [...queries], stops })); }
export function releaseMediaFixtureSearch(index: number) { searches[index]!.release(); }
const runtime = { resources: {
  host: { canRequest: (method: string) => method === "fuzzyFileSearch/sessionStart" },
  fileSystem: {
    async getMetadata(path: string) { return { isFile: path !== "/fixture", isDirectory: path === "/fixture", modifiedAtMs: 0 }; },
    async readDirectory() { return { entries: [] }; },
    createFuzzyFileSearchSession(options: SearchOptions) {
      return new Promise(resolve => {
        const search = { queries: [] as string[], stops: 0, release() { resolve({
          async update(query: string) {
            search.queries.push(query);
            options.onUpdated?.({ query, files: [{ root: "/fixture", path: "report.html", match_type: "file", file_name: "report.html", score: 10, indices: [] }] });
            options.onCompleted?.();
          },
          async stop() { search.stops++; },
        }); } };
        searches.push(search);
      });
    },
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
export function useAppServerSnapshot() { return { hostId: "media-fixture", conversation: { execution: { cwd: "/fixture", runtimeWorkspaceRoots: ["/fixture"] } } }; }
export function mediaFixtureReads() { return [...reads]; }
