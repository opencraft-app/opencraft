import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import type { BlobResourceService } from "@opencraft/blob-resources";
let blobs: BlobResourceService;
export const evidence = {
  local: 0,
  reads: [] as string[],
  writes: [] as string[],
  values: { A: "PRIVATE_A", B: "PRIVATE_B" } as Record<string, string>,
};
const denied = async () => {
  evidence.local++;
  throw Error("LOCAL_FALLBACK");
};
const runtime = {
  resources: {
    host: { canRequest: (method: string) => method === "fs/writeFile", getConnectionGeneration: () => 1 },
    fileSystem: { readFile: denied, getMetadata: denied, readDirectory: denied, writeFile: denied },
    workspaceFiles: {
      async open(id: string) {
        if (id === "denied") throw Error("Scope denied");
        return {
          location: { kind: "workspace", threadId: id, root: "/workspace" },
          files: {
            async getMetadata() {
              return { isFile: true, isDirectory: false, modifiedAtMs: 0 };
            },
            async readFile() {
              evidence.reads.push(id);
              return { dataBase64: btoa(evidence.values[id]!) };
            },
            async writeFile(_path: string, data: string) {
              evidence.writes.push(id);
              evidence.values[id] = atob(data);
            },
            async readDirectory() {
              return { entries: [] };
            },
          },
        };
      },
    },
  },
} as unknown as AppServerWorkbenchRuntime;
export function setScopeBlobs(value: BlobResourceService) {
  blobs = value;
}
export function useBlobResources() {
  return blobs;
}
export function useAppServerRuntime() {
  return runtime;
}
export function useAppServerSnapshot() {
  return {
    phase: "ready",
    hostId: "same-host",
    conversation: { execution: { cwd: "/local", runtimeWorkspaceRoots: ["/local"] } },
  };
}
