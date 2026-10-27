import { createConnection, createServer } from 'node:net';
import { Server as HttpServer } from 'node:http';

const httpMethods = ['GET ', 'HEAD ', 'POST ', 'PUT ', 'DELETE ', 'OPTIONS ', 'PATCH ', 'CONNECT ', 'TRACE '];
export function classifyProtocol(prefix) {
  const text = prefix.subarray(0, 8).toString('latin1');
  if (text.startsWith('SSH-')) return 'ssh';
  if (httpMethods.some(method => text.startsWith(method))) return 'http';
  return ['SSH-', ...httpMethods].some(method => method.startsWith(text)) ? 'pending' : 'reject';
}
/** Transparent routing only: SSH authentication belongs to Headless, never to Web. */
export function createProtocolIngress({ httpPort, httpServer = null, sshTarget, handshakeTimeoutMs = 10_000, maxConnections = 256 }) {
  const target = new URL(sshTarget);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash) throw new Error('SSH backend must be a loopback origin');
  const sshPort = Number(target.port || 80);
  if (![httpPort, sshPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)
    || !Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1
    || !Number.isSafeInteger(maxConnections) || maxConnections < 1
    || (httpServer !== null && !(httpServer instanceof HttpServer))) throw new Error('Invalid ingress configuration');
  const sockets = new Set(); const peers = new Set(); let closed = false; let closing;
  const server = createServer(socket => {
    if (closed || sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); clearTimeout(deadline); });
    let prefix = Buffer.alloc(0);
    const classify = chunk => {
      prefix = Buffer.concat([prefix, chunk]);
      const kind = classifyProtocol(prefix);
      if (kind === 'pending') return;
      socket.pause(); socket.off('data', classify);
      if (kind === 'reject') { socket.destroy(); return; }
      if (kind === 'http' && httpServer) {
        // Keep the actual peer, destination and public port at HTTP admission.
        clearTimeout(deadline);
        socket.unshift(prefix); prefix = null;
        httpServer.emit('connection', socket); socket.resume();
        return;
      }
      const peer = createConnection({ host: '127.0.0.1', port: kind === 'ssh' ? sshPort : httpPort });
      peers.add(peer);
      peer.once('close', () => { peers.delete(peer); socket.destroy(); });
      peer.on('error', () => socket.destroy());
      socket.once('close', () => peer.destroy());
      peer.once('connect', () => {
        clearTimeout(deadline);
        peer.write(prefix); prefix = null;
        socket.pipe(peer).pipe(socket); socket.resume();
      });
    };
    socket.on('data', classify);
  });
  return {
    listen({ host = '127.0.0.1', port = 10000 } = {}) {
      if (closed) throw new Error('Protocol ingress is closed');
      return new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, () => {
        server.off('error', reject); accept(server.address());
      }); });
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const socket of sockets) socket.destroy();
      for (const peer of peers) peer.destroy();
      closing = server.listening ? new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())) : Promise.resolve();
      return closing;
    },
  };
}
