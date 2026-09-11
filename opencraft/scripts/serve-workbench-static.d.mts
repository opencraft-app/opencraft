import type { AddressInfo } from "node:net";

export interface WorkbenchStaticServer {
  readonly staticRoot: string;
  listen(options?: { host?: string; port?: number }): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createWorkbenchStaticServer(options: {
  root: string;
}): Promise<WorkbenchStaticServer>;
