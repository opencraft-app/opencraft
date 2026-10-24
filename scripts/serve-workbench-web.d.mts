import type { AddressInfo } from "node:net";

export interface WorkbenchWebServer {
  readonly staticRoot: string;
  readonly appServerTarget: string | null;
  listen(options?: { host?: string; port?: number }): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createWorkbenchWebServer(options?: {
  root?: string;
  getImService?: () => { handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, sameOrigin: (request: import("node:http").IncomingMessage, requireOrigin: boolean) => boolean): Promise<boolean> } | null;
  appServerTarget?: string | null;
  resolveAppServerTarget?: () => Promise<string>;
  /** Hub-owned metadata overlay; trusted submission identity comes from server authentication. */
  appServerIdentity?: import("../apps/opencraft-daemon/src/appserver-identity-overlay").AppServerIdentityOverlay | null;
  hyperNodeUser?: string;
  codexServerTarget?: string | null;
}): Promise<WorkbenchWebServer>;
