export function projectDshPermissions(value: any) {
  if (!["ask", "never"].includes(value?.approval) || !["read-only", "workspace-write", "danger-full-access"].includes(value?.sandbox?.mode)) throw new Error("DSH effective permission metadata is unavailable");
  return {
    approvalPolicy: value.approval === "ask" ? "on-request" : "never",
    // DSH enforces file effects; externalSandbox reports that boundary.
    // It does not assert temporary-directory exclusions or OS process isolation.
    sandbox: value.sandbox.mode === "danger-full-access"
      ? { type: "dangerFullAccess" }
      : { type: "externalSandbox", networkAccess: "enabled" },
    activePermissionProfile: { id: value.preset, extends: null },
    dshPermissions: {
      mode: value.sandbox.mode, workspaceRoot: value.sandbox.workspaceRoot,
      approval: value.approval, preset: value.preset,
      networkPolicy: value.networkPolicy,
    },
  };
}
export interface DshPermissionPort {
  read(threadId?: string): Promise<any>;
  set(threadId: string, preset: string): Promise<any>;
}
