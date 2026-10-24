import type { PrivateStorage } from "./private-storage.js";

/** Trusted Main-process composition, never a renderer-supplied plugin. */
export interface DesktopProductPorts {
  readonly userDataDirectory: string;
  readonly privateStorage: PrivateStorage;
  openExternal(url: string): Promise<void>;
  showWindow(): Promise<void>;
  registerProtocol(): void;
  /** Main fences every handler to its current top-level workbench frame. */
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
}

export interface DesktopProductSession {
  /** null means no cross-process forwarding is pending. */
  receiveUrl(url: string): Promise<boolean> | null;
  cancelInteractions(): void;
  dispose(): void;
}

export type DesktopProductFactory = (ports: DesktopProductPorts) => DesktopProductSession;

export interface DesktopPreloadPort {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
}

export type DesktopPreloadFactory = (port: DesktopPreloadPort) => Readonly<Record<string, unknown>>;
