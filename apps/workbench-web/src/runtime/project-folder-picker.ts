import type { HostRuntimeDescriptor } from "@opencraft/workbench-runtime";

export interface NativeProjectPicker {
  pickDirectory(): Promise<string | null>;
}

export function nativeProjectPicker(host: Pick<HostRuntimeDescriptor, "kind">): NativeProjectPicker | null {
  if (host.kind !== "local") return null;
  const desktop = (globalThis as typeof globalThis & {
    opencraftDesktop?: { kind?: string; projects?: NativeProjectPicker };
  }).opencraftDesktop;
  return desktop?.kind === "electron" && typeof desktop.projects?.pickDirectory === "function"
    ? desktop.projects : null;
}
