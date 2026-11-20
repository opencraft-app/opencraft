import net from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

// Linux sun_path holds 108 bytes including the terminating NUL.
const LINUX_SOCKET_PATH_MAX = 107;

/** Resolves a bindable address for a profile socket. The socket file stays at `path` inside the
 * private profile directory; when that absolute path exceeds Linux sun_path, the address goes
 * through an open handle on the parent directory instead of moving the socket elsewhere. The
 * caller owns the returned handle and must keep it open while the address is in use: libuv
 * unlinks a listening socket by its bound address on close. */
async function socketAddress(path) {
  if (process.platform !== "linux" || Buffer.byteLength(path) <= LINUX_SOCKET_PATH_MAX)
    return { address: path, close: async () => {} };
  const directory = await openFile(dirname(path), "r");
  return {
    address: `/proc/self/fd/${directory.fd}/${basename(path)}`,
    close: () => directory.close(),
  };
}

/** Owns transport resources only. The caller must own the profile lease before open(). */
export class UnixSocketGateway {
  constructor(path, handler) {
    this.path = path;
    this.handler = handler;
    this.connections = new Set();
  }
  async open() {
    if (existsSync(this.path)) unlinkSync(this.path);
    this.address = await socketAddress(this.path);
    this.server = net.createServer((socket) => this.connection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.address.address, resolve);
    });
    chmodSync(this.path, 0o600);
  }
  connection(socket) {
    socket.setEncoding("utf8");
    this.connections.add(socket);
    let buffer = "",
      pending = 0,
      chain = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 262144) {
        socket.destroy();
        return;
      }
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (++pending > 32) {
          socket.destroy();
          return;
        }
        // Host-backed calls are async. Preserve wire order and bound buffered requests.
        chain = chain
          .then(async () => {
            if (socket.destroyed) {
              pending--;
              return;
            }
            let response;
            try {
              response = {
                ok: true,
                result: await this.handler(JSON.parse(line)),
              };
            } catch (error) {
              response = { ok: false, error: String(error.message ?? error) };
            } finally {
              pending--;
            }
            if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
          })
          .catch(() => socket.destroy());
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.connections.delete(socket));
  }
  async close() {
    for (const socket of this.connections) socket.destroy();
    if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
    const address = this.address;
    this.address = undefined;
    await address?.close();
  }
}

export async function request(profile, message, timeoutMs = 5000) {
  const address = await socketAddress(profile.socket);
  try {
    return await exchange(address.address, message, timeoutMs);
  } finally {
    await address.close();
  }
}

function exchange(address, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Runner request timed out")));
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, at));
        response.ok ? resolve(response.result) : reject(new Error(response.error));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (!buffer.includes("\n")) reject(new Error("Runner closed before replying"));
    });
  });
}
