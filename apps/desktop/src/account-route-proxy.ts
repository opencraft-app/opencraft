import { request as forward, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Native Main serves the renderer, but the account service belongs to the
 * daemon. Account routes are forwarded unchanged (including Host and cookies)
 * to the daemon's private local socket, which checks them against the origin
 * Main attached.
 */
export function createAccountRouteProxy(endpoint: () => string | null) {
  return {
    handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const socketPath = endpoint();
      if (!socketPath) {
        response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        response.end('{"error":"account_unavailable"}');
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const upstream = forward(
          { socketPath, method: request.method, path: request.url, headers: request.headers },
          (reply) => {
            response.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(response);
            reply.once("end", () => resolve(true));
            reply.once("error", () => {
              response.destroy();
              resolve(true);
            });
          },
        );
        upstream.once("error", () => {
          if (!response.headersSent) {
            response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
            response.end('{"error":"account_unavailable"}');
          } else response.destroy();
          resolve(true);
        });
        request.pipe(upstream);
      });
    },
  };
}
