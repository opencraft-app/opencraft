import type { AppServerClient } from "@opencraft/appserver-client";
import {
  WORKSPACE_PLACEMENT_EXTENSION,
  supportsWorkspaceFiles,
  type AppServerMethodParams,
  type AppServerMethodResult,
} from "@opencraft/appserver-protocol";
import type { AppServerFileSystemResourcePort } from "./appserver-runtime";
/** Retains the caller's captured connection and scopes every file operation. */
export async function openWorkspaceFiles(
  owner: AppServerClient,
  threadId: string,
  local: AppServerFileSystemResourcePort,
  assertConnection: () => void,
  signal?: AbortSignal,
) {
  const assertCurrent = () => {
    assertConnection();
    const extension = owner.initializeResult?.capabilities?.extensions?.[WORKSPACE_PLACEMENT_EXTENSION];
    if (!supportsWorkspaceFiles(extension)) throw Error("Workspace file connection unavailable");
  };
  assertCurrent();
  const location = await owner.request("workspace/files/scope", { threadId }, { signal });
  assertCurrent();
  if (
    location.kind !== "host" &&
    (location.kind !== "workspace" ||
      location.threadId !== threadId ||
      typeof location.root !== "string" ||
      !location.root.startsWith("/"))
  )
    throw Error("Invalid workspace file location");
  const scope = location.kind === "workspace" ? { workspaceThreadId: threadId } : {};
  const read = async <M extends "fs/getMetadata" | "fs/readFile" | "fs/readDirectory" | "fs/writeFile">(
    method: M,
    params: AppServerMethodParams<M>,
    readSignal?: AbortSignal,
  ): Promise<AppServerMethodResult<M>> => {
    assertCurrent();
    const result = await owner.request(method, { ...params, ...scope }, { signal: readSignal });
    assertCurrent();
    return result;
  };
  const files: AppServerFileSystemResourcePort = {
    getMetadata: (path, signal) => read("fs/getMetadata", { path }, signal),
    readFile: (path, signal) => read("fs/readFile", { path }, signal),
    readDirectory: (path) => read("fs/readDirectory", { path }),
    writeFile: (path, dataBase64) => read("fs/writeFile", { path, dataBase64 }),
    async watch(path, listener) {
      assertCurrent();
      if (location.kind !== "host") throw Error("Workspace file watch is unsupported");
      return local.watch(path, listener);
    },
    async createFuzzyFileSearchSession(options) {
      assertCurrent();
      if (location.kind !== "host") throw Error("Workspace file search is unsupported");
      return local.createFuzzyFileSearchSession(options);
    },
  };
  return { location, files };
}
