export interface NativeProjectPicker {
  pickDirectory(): Promise<string | null>;
}

export function nativeProjectPicker(hostId: string): NativeProjectPicker | null {
  if (hostId !== "local") return null;
  const desktop = (globalThis as typeof globalThis & {
    opencraftDesktop?: { kind?: string; projects?: NativeProjectPicker };
  }).opencraftDesktop;
  return desktop?.kind === "electron" && typeof desktop.projects?.pickDirectory === "function"
    ? desktop.projects : null;
}
