import { WORKSPACE_FILE_SCOPE_METHOD } from "@opencraft/appserver-protocol";
import { parseWorkspaceEndpointUri, type WorkspaceRuntime } from "@opencraft/sandbox";
import { endpointHttpRequest } from "./workspace-link.js";
import { PROJECTLESS_WORKSPACE } from "./workspace-paths.js";

export const WORKSPACE_FILE_METHODS = [
  WORKSPACE_FILE_SCOPE_METHOD,
  "fs/readDirectory",
  "fs/getMetadata",
  "fs/readFile",
  "fs/writeFile",
] as const;
type WorkspaceFileMethod = (typeof WORKSPACE_FILE_METHODS)[number];
type WorkspaceFileRequest = {
  method: Exclude<WorkspaceFileMethod, typeof WORKSPACE_FILE_SCOPE_METHOD>;
  params: { path: string; dataBase64?: unknown };
};
const MAX_FILE_BYTES = 512 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const isWorkspaceFileMethod = (method: unknown): method is WorkspaceFileMethod =>
  typeof method === "string" && (WORKSPACE_FILE_METHODS as readonly string[]).includes(method);

export function isWorkspaceFilePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 4096 &&
    !/[\\\x00-\x1f\x7f]/u.test(path) &&
    (path === PROJECTLESS_WORKSPACE ||
      (path.startsWith(PROJECTLESS_WORKSPACE + "/") &&
        path
          .slice(PROJECTLESS_WORKSPACE.length + 1)
          .split("/")
          .every((segment) => segment && segment !== "." && segment !== "..")))
  );
}

export function parseWorkspaceFileCall(method: unknown, value: unknown) {
  if (!isWorkspaceFileMethod(method) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const params = value as Record<string, unknown>;
  const threadId = method === WORKSPACE_FILE_SCOPE_METHOD ? params.threadId : params.workspaceThreadId;
  if (typeof threadId !== "string" || !threadId.length || threadId.length > 512 || /[\x00-\x1f\x7f]/u.test(threadId))
    return null;
  if (method === WORKSPACE_FILE_SCOPE_METHOD)
    return Object.keys(params).length === 1 ? { method, threadId, params: null } : null;
  const { path, dataBase64 } = params;
  const write = method === "fs/writeFile";
  if (
    !isWorkspaceFilePath(path) ||
    Object.keys(params).some(
      (key) => key !== "workspaceThreadId" && key !== "path" && !(write && key === "dataBase64"),
    ) ||
    (write && !isFileContent(dataBase64))
  )
    return null;
  return { method, threadId, params: { path, ...(write ? { dataBase64 } : {}) } } satisfies WorkspaceFileRequest & {
    threadId: string;
  };
}

function isFileContent(value: unknown): value is string {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !BASE64.test(value))
    return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding <= MAX_FILE_BYTES;
}

export function isWorkspaceFileResult(method: WorkspaceFileMethod, result: unknown, threadId?: string): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as Record<string, unknown>;
  if (method === WORKSPACE_FILE_SCOPE_METHOD)
    return (
      threadId !== undefined &&
      value.kind === "workspace" &&
      value.threadId === threadId &&
      value.root === PROJECTLESS_WORKSPACE
    );
  if (method === "fs/writeFile") return Object.keys(value).length === 0;
  if (method === "fs/readFile") return isFileContent(value.dataBase64);
  if (method === "fs/getMetadata")
    return (
      [value.isDirectory, value.isFile, value.isSymlink].every((item) => typeof item === "boolean") &&
      [value.createdAtMs, value.modifiedAtMs].every((item) => typeof item === "number" && Number.isFinite(item))
    );
  return (
    Array.isArray(value.entries) &&
    value.entries.length <= 2000 &&
    value.entries.every(
      (item) =>
        typeof item?.fileName === "string" &&
        !!item.fileName &&
        item.fileName !== "." &&
        item.fileName !== ".." &&
        !/[\/\\\x00-\x1f\x7f]/u.test(item.fileName) &&
        typeof item.isDirectory === "boolean" &&
        typeof item.isFile === "boolean",
    )
  );
}

export async function requestWorkspaceFile(
  runtime: WorkspaceRuntime,
  call: WorkspaceFileRequest,
  authorize: () => Promise<void>,
) {
  const endpoint = parseWorkspaceEndpointUri(`workspace://${runtime.workspaceId}/endpoints/files`);
  return runtime.fenced(endpoint, async () => {
    const descriptor = (await runtime.describe(endpoint)) as { token?: unknown } | null;
    const token = descriptor?.token;
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) throw Error("Workspace file owner unavailable");
    await authorize();
    const response = await endpointHttpRequest((onData) => runtime.connect(endpoint, onData), "/workspace/rpc", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method: call.method, params: call.params }),
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 15_000,
    });
    if (!response.ok) throw Error("Workspace file operation unavailable");
    const result = (response.json() as { result?: unknown } | null)?.result;
    if (!isWorkspaceFileResult(call.method, result)) throw Error("Workspace file response unavailable");
    return result;
  });
}
