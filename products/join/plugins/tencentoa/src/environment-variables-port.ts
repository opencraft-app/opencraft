import type { EnvironmentEditorPort } from "@opencraft/extension-react";
import { parseEnvironmentDocument } from "@opencraft/workbench-runtime";
import { TENCENTOA_ENVIRONMENT_PATH } from "./contract";
import type { TencentOaController } from "./controller";

/** One account-fenced adapter for personal ENV; the server remains the only writer. */
export function createPersonalEnvironmentPort(
  controller: TencentOaController,
  fetcher: typeof fetch,
  account: string,
): EnvironmentEditorPort {
  const request = async (
    projectId: string | null,
    signal: AbortSignal,
    body?: unknown,
  ) => {
    const url =
      TENCENTOA_ENVIRONMENT_PATH +
      (body === undefined && projectId !== null
        ? `?projectId=${encodeURIComponent(projectId)}`
        : "");
    signal.throwIfAborted();
    const before = controller.getSnapshot().identity;
    if (!before || `tencentoa:${before.staffId}` !== account)
      throw new Error("unauthenticated");
    const response = await fetcher(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        "x-opencraft-account-scope": account ?? "",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    signal.throwIfAborted();
    const current = controller.getSnapshot().identity;
    if (!current || `tencentoa:${current.staffId}` !== account)
      throw new Error("unauthenticated");
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null);
      const code =
        error && typeof error === "object" && "error" in error
          ? error.error
          : null;
      if (response.status === 401) void controller.refresh();
      throw new Error(
        ["reserved", "invalid", "conflict"].includes(String(code))
          ? String(code)
          : "unavailable",
      );
    }
    const result = parseEnvironmentDocument(await response.json());
    signal.throwIfAborted();
    const latest = controller.getSnapshot().identity;
    if (!latest || `tencentoa:${latest.staffId}` !== account)
      throw new Error("unauthenticated");
    if (result.projectId !== projectId) throw new Error("invalid");
    return result;
  };
  return {
    load: (projectId, signal) => request(projectId, signal),
    save: (document, variables, signal) =>
      request(document.projectId, signal, {
        projectId: document.projectId,
        revision: document.revision,
        variables,
      }),
  };
}
