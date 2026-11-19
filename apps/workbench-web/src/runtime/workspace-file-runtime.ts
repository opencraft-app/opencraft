import type { AppServerWorkbenchRuntime, AppServerFileSystemResourcePort } from "@opencraft/workbench-runtime";
const scoped = new WeakSet<AppServerWorkbenchRuntime>();
/** Separate identity isolates file caches while preserving the connection owner. */
export function workspaceFileRuntime(
  runtime: AppServerWorkbenchRuntime,
  files: AppServerFileSystemResourcePort,
): AppServerWorkbenchRuntime {
  const projection = { ...runtime, resources: { ...runtime.resources, fileSystem: files } };
  scoped.add(projection);
  return projection;
}
export const isWorkspaceFileRuntime = (runtime: AppServerWorkbenchRuntime) => scoped.has(runtime);
export const unavailableWorkspaceFiles: AppServerFileSystemResourcePort = {
  async getMetadata() {
    throw Error("Workspace files unavailable");
  },
  async readDirectory() {
    throw Error("Workspace files unavailable");
  },
  async readFile() {
    throw Error("Workspace files unavailable");
  },
  async writeFile() {
    throw Error("Workspace files unavailable");
  },
  async watch() {
    throw Error("Workspace file watch unavailable");
  },
  async createFuzzyFileSearchSession() {
    throw Error("Workspace file search unavailable");
  },
};
