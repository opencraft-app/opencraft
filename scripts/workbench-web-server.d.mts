import type { AddressInfo } from "node:net";

export interface WorkbenchWebServer {
  readonly staticRoot: string;
  readonly appServerTarget: string | null;
  listen(options?: { host?: string; port?: number }): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createWorkbenchWebServer(options?: {
  root?: string;
  appServerTarget?: string | null;
  hyperNodeUser?: string;
  codexServerTarget?: string | null;
  headlessServer?: boolean;
  optionalResources?: { resolveFile(pathname: string): Promise<string | null>; prepare(buildId: string): Promise<boolean> } | null;
}): Promise<WorkbenchWebServer>;
