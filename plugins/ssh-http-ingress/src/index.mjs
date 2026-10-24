// plugins/ssh-http-ingress/src/index.ts
import { createConnection, createServer } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ssh2 from "ssh2";

import { parseCodexProxyCommand, codexCommandShape } from "./codex-command.mjs";

// plugins/ssh-http-ingress/src/index.ts
const { Server: SshServer, utils } = ssh2;
async function loadSshIngressConfiguration(path) {
  const readPrivate = async (filename) => {
    const info = await stat(filename);
    if (!info.isFile() || process.platform !== "win32" && (info.mode & 63) !== 0) throw new Error("SSH configuration and host key must be private files (mode 0600)");
    return readFile(filename, "utf8");
  };
  const input = JSON.parse(await readPrivate(path));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid SSH configuration");
  const config = input;
  if (Object.keys(config).some((key) => !["hostKeyFile", "authorizedKeys"].includes(key)) || typeof config.hostKeyFile !== "string" || !config.hostKeyFile.trim()) throw new Error("Invalid SSH configuration fields");
  if (!config.authorizedKeys || typeof config.authorizedKeys !== "object" || Array.isArray(config.authorizedKeys)) throw new Error("Invalid SSH public key directory");
  const keys = Object.entries(config.authorizedKeys);
  if (!keys.length || keys.some(([name, values]) => !name || !Array.isArray(values) || !values.length || values.some((value) => typeof value !== "string"))) throw new Error("Invalid SSH public key directory");
  return { hostKey: await readPrivate(resolve(dirname(path), config.hostKeyFile)), authorizedKeys: Object.fromEntries(keys) };
}
const httpPrefixes = ["GET ", "HEAD ", "POST ", "PUT ", "DELETE ", "OPTIONS ", "PATCH ", "CONNECT ", "TRACE "];
function classifyIngress(prefix) {
  const text = prefix.subarray(0, 8).toString("latin1");
  if (text.startsWith("SSH-")) return "ssh";
  if (httpPrefixes.some((value) => text.startsWith(value))) return "http";
  return ["SSH-", ...httpPrefixes].some((value) => value.startsWith(text)) ? "pending" : "reject";
}
function parsePublicKey(value) {
  const key = utils.parseKey(value);
  if (key instanceof Error || Array.isArray(key) || key.isPrivateKey()) throw new Error("Invalid authorized public key");
  return key;
}
function createSshHttpIngress(options) {
  if (!Number.isInteger(options.httpPort) || options.httpPort < 1 || options.httpPort > 65535) throw new Error("Invalid private HTTP port");
  if (options.codexPort !== void 0 && (!Number.isInteger(options.codexPort) || options.codexPort < 1 || options.codexPort > 65535)) throw new Error("Invalid private Codex port");
  const principals = new Map(Object.entries(options.authorizedKeys).map(([username, keys]) => {
    if (!username || keys.length === 0) throw new Error("SSH principal requires public keys");
    return [username, keys.map(parsePublicKey)];
  }));
  if (principals.size === 0) throw new Error("SSH ingress requires authorized public keys");
  const timeoutMs = options.handshakeTimeoutMs ?? 1e4;
  const limit = options.maxConnections ?? 256;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid ingress limits");
  const sockets = /* @__PURE__ */ new Set();
  const peers = /* @__PURE__ */ new Set();
  let closing = false;
  let closeOperation;
  const bridge = (stream, port = options.httpPort) => {
    const peer = createConnection({ host: "127.0.0.1", port });
    peers.add(peer);
    peer.setTimeout(timeoutMs, () => peer.destroy());
    peer.once("connect", () => peer.setTimeout(0));
    peer.on("error", () => stream.destroy());
    stream.on("error", () => peer.destroy());
    stream.once("close", () => peer.destroy());
    peer.once("close", () => {
      peers.delete(peer);
      stream.destroy();
    });
    stream.pipe(peer).pipe(stream);
  };
  const parsedHostIdentity = utils.parseKey(options.hostKey);
  const hostIdentity = Array.isArray(parsedHostIdentity) && parsedHostIdentity.length === 1 ? parsedHostIdentity[0] : parsedHostIdentity;
  if (hostIdentity instanceof Error || Array.isArray(hostIdentity) || !hostIdentity?.isPrivateKey()) throw new Error("Invalid SSH host private key");
  const acceptSsh = (socket, ready) => {
    const ssh = new SshServer({ hostKeys: [options.hostKey], ident: "OpenCraft" }, (client) => {
      client.once("ready", ready);
      let authenticated = false;
      let attempts = 0;
      let channels = 0;
      client.on("error", () => {
      });
      client.on("authentication", (context) => {
        if (++attempts > 8) {
          context.reject();
          client.end();
          return;
        }
        if (context.method !== "publickey") {
          context.reject(["publickey"]);
          return;
        }
        const key = principals.get(context.username)?.find((candidate) => {
          const data = candidate.getPublicSSH();
          return data.length === context.key.data.length && timingSafeEqual(data, context.key.data);
        });
        if (!key || context.signature && key.verify(context.blob, context.signature, context.hashAlgo) !== true) {
          context.reject(["publickey"]);
          return;
        }
        if (context.signature) authenticated = true;
        context.accept();
      });
      client.on("session", (accept, reject) => {
        if (closing || !authenticated || channels >= 16) {
          reject();
          return;
        }
        channels++;
        const session = accept();
        session.once("close", () => channels--);
        session.on("exec", (acceptExec, rejectExec, info) => {
          if (closing) {
            rejectExec();
            return;
          }
          if (info.command === "opencraft app-server proxy") {
            bridge(acceptExec());
            return;
          }
          const recipe = parseCodexProxyCommand(info.command);
          if (!recipe || options.codexPort === void 0) {
            console.info("[opencraft ssh ingress]", JSON.stringify({ event: "exec-rejected", reason: recipe ? "native-gateway-unavailable" : "unsupported-recipe", commandLength: info.command.length, shape: codexCommandShape(info.command) }));
            rejectExec();
            return;
          }
          const stream = acceptExec();
          console.info("[opencraft ssh ingress]", JSON.stringify({ event: "exec-admitted", action: recipe.kind }));
          if (recipe.sentinel.length) stream.write(recipe.sentinel);
          if (recipe.kind !== "proxy") {
            const controller = new AbortController();
            const deadline = setTimeout(() => {
              controller.abort();
              stream.destroy();
            }, 3e4);
            stream.once("close", () => {
              clearTimeout(deadline);
              controller.abort();
            });
            stream.on("error", () => controller.abort());
            const finish = (output, code) => {
              clearTimeout(deadline);
              if (stream.destroyed || controller.signal.aborted) {
                stream.destroy();
                return;
              }
              if (output) stream.write(output);
              stream.exit(code);
              stream.end();
            };
            if (!options.codexControl) {
              finish("", 1);
              return;
            }
            void options.codexControl(recipe.kind, controller.signal).then((output) => finish(output, 0), () => finish("", 1));
            return;
          }
          bridge(stream, options.codexPort);
        });
        session.on("shell", (_accept, rejectShell) => rejectShell());
        session.on("pty", (_accept, rejectPty) => rejectPty());
        session.on("subsystem", (_accept, rejectSubsystem) => rejectSubsystem());
      });
      client.on("tcpip", (_accept, reject) => reject());
      client.on("request", (_accept, reject) => reject?.());
    });
    ssh.injectSocket(socket);
  };
  const server = createServer((socket) => {
    if (closing || sockets.size >= limit) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once("close", () => clearTimeout(deadline));
    socket.on("error", () => {
    });
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(timeoutMs, () => socket.destroy());
    let prefix = Buffer.alloc(0);
    const classify = (chunk) => {
      prefix = Buffer.concat([prefix, chunk]);
      const kind = classifyIngress(prefix);
      if (kind === "pending") return;
      socket.pause();
      socket.off("data", classify);
      socket.setTimeout(0);
      if (kind === "reject") {
        socket.destroy();
        return;
      }
      socket.unshift(prefix);
      prefix = Buffer.alloc(0);
      if (kind === "ssh") {
        try {
          acceptSsh(socket, () => clearTimeout(deadline));
        } catch {
          socket.destroy();
        }
      } else {
        clearTimeout(deadline);
        bridge(socket);
        socket.resume();
      }
    };
    socket.on("data", classify);
  });
  return {
    async listen({ host = "127.0.0.1", port = 80 } = {}) {
      if (closing) throw new Error("SSH/HTTP ingress is closed");
      return new Promise((resolve2, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve2(server.address());
        });
      });
    },
    close() {
      if (closeOperation) return closeOperation;
      closing = true;
      for (const socket of sockets) socket.destroy();
      for (const peer of peers) peer.destroy();
      closeOperation = server.listening ? new Promise((resolve2, reject) => server.close((error) => error ? reject(error) : resolve2())) : Promise.resolve();
      return closeOperation;
    }
  };
}
export {
  classifyIngress,
  createSshHttpIngress,
  loadSshIngressConfiguration
};
