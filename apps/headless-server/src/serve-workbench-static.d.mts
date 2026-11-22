import type { AddressInfo } from "node:net";

export interface WorkbenchStaticServer {
  readonly staticRoot: string;
  listen(options?: { host?: string; port?: number }): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createWorkbenchStaticServer(options: {
  root: string;
  accountService?: { handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<boolean> };
}): Promise<WorkbenchStaticServer>;
