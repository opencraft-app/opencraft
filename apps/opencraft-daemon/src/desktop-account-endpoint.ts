import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

const isNamedPipe = (endpoint: string) => endpoint.startsWith("\\\\.\\pipe\\");

/** The account routes listen beside the daemon IPC endpoint, never on a TCP port. */
export function desktopAccountEndpoint(daemonEndpoint: string): string {
  return isNamedPipe(daemonEndpoint)
    ? `${daemonEndpoint}-account`
    : join(dirname(daemonEndpoint), "opencraft-account.sock");
}

export interface DesktopAccountServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

/**
 * Serve the daemon-owned account routes on a private local socket. Native Main
 * forwards `/setup`, `/__opencraft_account` and `/__opencraft_auth` here; the
 * account service still checks the forwarded Host against the attached origin.
 */
export async function startDesktopAccountServer(
  endpoint: string,
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>,
): Promise<DesktopAccountServer> {
  if (!isNamedPipe(endpoint)) {
    // Only the single daemon storage owner reaches this point; replace its own stale socket.
    try {
      const existing = await lstat(endpoint);
      if (!existing.isSocket()) throw new Error("Desktop account endpoint path is occupied");
      await rm(endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const respond = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (await handle(request, response)) return;
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"missing"}');
    } catch (error) {
      console.error("[opencraft account]", error);
      if (!response.headersSent) {
        response.writeHead(500);
        response.end();
      } else response.destroy();
    }
  };
  const server = createServer((request, response) => void respond(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!isNamedPipe(endpoint)) await chmod(endpoint, 0o600);
  return {
    endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
