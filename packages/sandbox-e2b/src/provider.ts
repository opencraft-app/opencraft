import type { PersistentWorkspaceProvider, SandboxProviderDefinition } from "@opencraft/sandbox/providers";
import { e2bSandboxBackend, type E2BConnection } from "./index.js";
import { createE2BPersistentWorkspaceInspector } from "./workspace-inspector.js";
import { verifyE2BWorkspaceMounts } from "./workspace-mounts.js";

/** Secret-free E2B installation identity, the `e2b` variant of a provider-typed installation. */
export interface E2BInstallation {
  readonly backend: "e2b";
  readonly apiUrl: string;
  readonly sandboxUrl: string;
}
export interface E2BProviderOptions {
  /** Injectable vendor boundaries for deterministic tests. */
  readonly connection?: E2BConnection;
  readonly request?: typeof fetch;
}
const unavailable = () => Error("ordinary_workspace_allocation_unavailable");

/** Reads the schemaVersion 2 workspace API extension and requires the created
 * instance to be the workspace's only member before trusting its private volume. */
async function workspaceReceipt(
  input: Parameters<PersistentWorkspaceProvider<E2BInstallation>["receipt"]>[0],
  request: typeof fetch,
) {
  await input.authorize();
  const key = await input.readSecret();
  const response = await request(input.installation.apiUrl + "/workspaces/" + input.workspaceId, {
    headers: { "X-API-Key": key },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let decoded: unknown;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) throw unavailable();
      chunks.push(part.value);
    }
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw unavailable();
  const value = decoded as Record<string, unknown>;
  if (
    value.schemaVersion !== 2 ||
    value.workspaceID !== input.workspaceId ||
    typeof value.privateVolumeID !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.privateVolumeID) ||
    !Array.isArray(value.members) ||
    value.members.length !== 1 ||
    !value.members[0] ||
    typeof value.members[0] !== "object" ||
    value.members[0].sandboxID !== input.instanceId
  )
    throw unavailable();
  await input.authorize();
  return { instanceId: input.instanceId, privateVolumeId: value.privateVolumeID };
}

/** E2B provider definition for deployment assembly. The persistent-workspace
 * capability requires the provider's schemaVersion 2 workspace/volume extension
 * and its NFS `/workspace` and `/shared` mounts. */
export function e2bSandboxProvider(options: E2BProviderOptions = {}): SandboxProviderDefinition<E2BInstallation> {
  const request: typeof fetch = (...args) => (options.request ?? fetch)(...args);
  return {
    id: "e2b",
    // `e2b://<template>`: the same template grammar the backend enforces.
    acceptsTarget: (target) => /^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,199}$/u.test(target),
    createBackend: (input) =>
      e2bSandboxBackend(
        {
          apiUrl: input.installation.apiUrl,
          sandboxUrl: input.installation.sandboxUrl,
          templateId: input.templateId,
          ...(input.python === undefined ? {} : { python: input.python }),
          readApiKey: input.readSecret,
          ...(input.readWorkspaceId ? { readWorkspaceId: input.readWorkspaceId } : {}),
          ...(input.onCreated ? { onCreated: input.onCreated } : {}),
          timeoutMs: input.timeoutMs,
          requestTimeoutMs: input.requestTimeoutMs,
          ...(input.lease ? { lease: input.lease } : {}),
        },
        ...(options.connection ? [options.connection] : []),
      ),
    persistentWorkspaces: {
      receipt: (input) => workspaceReceipt(input, request),
      inspect: (input) =>
        createE2BPersistentWorkspaceInspector(
          {
            apiUrl: input.installation.apiUrl,
            readApiKey: input.readSecret,
            authorize: async (workspaceId) => {
              if (workspaceId !== input.binding.workspaceId) throw unavailable();
              await input.authorize();
            },
          },
          request,
        )({ ...input.binding }),
      verifyMounts: (input) =>
        verifyE2BWorkspaceMounts({
          sandbox: input.sandbox,
          workspaceId: input.workspaceId,
          instanceId: input.instanceId,
          privateVolumeId: input.privateVolumeId,
          ...(input.library ? { library: input.library } : {}),
          apiUrl: input.installation.apiUrl,
          readApiKey: input.readSecret,
          authorize: input.authorize,
          onCleanupUnconfirmed: input.onCleanupUnconfirmed,
          request,
        }),
    },
  };
}
