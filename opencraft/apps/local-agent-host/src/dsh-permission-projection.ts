export function projectDshPermissions(value: any) {
  if (!["ask", "never"].includes(value?.approval) || !["read-only", "workspace-write", "danger-full-access"].includes(value?.sandbox?.mode)) throw new Error("DSH effective permission metadata is unavailable");
  return {
    approvalPolicy: value.approval === "ask" ? "on-request" : "never",
    // DSH owns file-effect enforcement. Do not claim Codex's tmp exclusions
    // or a full OS workspace sandbox from a different provider's metadata.
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
