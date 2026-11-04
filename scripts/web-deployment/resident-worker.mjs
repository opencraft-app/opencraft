// The resident only transfers original sockets and private control messages.
// Admission and administrator sessions remain owned by this entry generation.
export async function prepareResidentWorker(prepare) {
  if (!process.send || !process.connected) throw new Error('Resident entry requires private IPC');
  let activate;
  const activation = new Promise(resolve => { activate = resolve; });
  let phase = 'preparing', app, ingress, finish, draining = false, stopping = false;
  const sockets = new Set(), http = new Map();
  const send = value => { if (process.connected) process.send({ protocol: 1, ...value }); };
  const report = () => send({ event: 'connections', count: sockets.size });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await finish?.();
    process.exit(0);
  };
  const drained = () => { if (draining && sockets.size === 0) void stop(); };
  const observeHttp = server => {
    if (!server) return;
    server.on('request', (request, response) => {
      const socket = request.socket;
      const state = http.get(socket) || { pending: 0 };
      http.set(socket, state); state.pending++;
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true; state.pending--;
        if (draining && state.pending === 0) socket.end();
      };
      response.once('finish', complete); response.once('close', complete);
    });
    server.on('upgrade', (_request, socket) => http.delete(socket));
  };
  process.on('message', (message, socket) => {
    if (message?.protocol !== 1) { socket?.destroy(); return; }
    if (message.command === 'socket') {
      if (phase !== 'active' || !socket || !['public', 'internal'].includes(message.channel)) { socket?.destroy(); return; }
      sockets.add(socket); socket.on('error', () => {});
      socket.once('close', () => { sockets.delete(socket); http.delete(socket); report(); drained(); });
      report();
      if (message.channel === 'internal') {
        if (!app.internalServer) { socket.destroy(); return; }
        app.internalServer.emit('connection', socket); socket.resume();
      } else if (ingress) ingress.acceptSocket(socket);
      else { app.server.emit('connection', socket); socket.resume(); }
      return;
    }
    if (message.command === 'activate' && phase === 'prepared') {
      phase = 'activating'; activate(message); return;
    }
    if (message.command === 'deactivate' && phase === 'active') {
      phase = 'deactivating';
      void app.deactivate().then(state => {
        phase = 'retired'; send({ id: message.id, ok: true, value: state });
      }, error => { phase = 'active'; send({ id: message.id, ok: false, error: error.code === 'entry-busy' ? 'entry-busy' : 'entry-command-failed' }); });
      return;
    }
    if (message.command === 'drain' && phase === 'retired') {
      draining = true;
      for (const [socket, state] of http) if (state.pending === 0) socket.end();
      drained(); return;
    }
    if (message.id) send({ id: message.id, ok: false, error: 'invalid-entry-phase' });
  });
  process.once('disconnect', () => { if (finish) void stop(); else process.exit(1); });
  await prepare();
  phase = 'prepared'; send({ event: 'prepared' });
  const request = await activation;
  return {
    administratorState: request.administratorState ?? null,
    reconcileExecution: request.reconcileExecution !== false,
    ready(application, protocolIngress, shutdown) {
      app = application; ingress = protocolIngress; finish = shutdown;
      observeHttp(app.server); observeHttp(app.internalServer);
      phase = 'active'; send({ id: request.id, ok: true });
    },
  };
}
