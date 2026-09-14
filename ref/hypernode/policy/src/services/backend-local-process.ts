import type { JsonRpcRequest } from "../types/appserver.ts";

function executableName(command: readonly unknown[]): string {
  return String(command[0] ?? "").split("/").at(-1) ?? "";
}

// Desktop reads images and other generated previews by spawning `cat` in the
// same app-server runtime that produced the file. These paths belong to the
// per-Thread container rather than HyperNode's public VFS namespace.
export function isBackendLocalArtifactRead(message: JsonRpcRequest): boolean {
  if (message.method !== "process/spawn") return false;
  const command = message.params?.["command"];
  if (!Array.isArray(command) || command.length !== 2 || executableName(command) !== "cat") return false;
  const path = command[1];
  return typeof path === "string" && path.startsWith("/tmp/") && !path.includes("/../");
}
