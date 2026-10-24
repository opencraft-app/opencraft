// Run only in the isolated desktop fixture via agent-browser eval --stdin.
// Uses the same transferred App Host port as ordinary renderer clients.
(async () => {
  const rendererId = `skills-acceptance-${crypto.randomUUID()}`;
  const leaseId = `${rendererId}:local`;
  const channel = new MessageChannel();
  const pending = new Map();
  let nextId = 0, generation;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const wait = (key, send) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timed out: ${key}`)); }, 15000);
    pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    send();
  });
  channel.port1.onmessage = ({ data }) => {
    if (data.type === "fatal") { console.error(data.error.message); return; }
    if (data.type === "ready") { readyResolve(); return; }
    const frame = data.type === "host/frame" ? JSON.parse(data.frame) : data;
    const key = data.type === "host/frame" ? frame.id : data.requestId;
    const call = pending.get(key);
    if (!call) return;
    pending.delete(key);
    frame.error ? call.reject(new Error(frame.error.message)) : call.resolve(frame.result);
  };
  channel.port1.start();
  window.postMessage({ type: "opencraft:connect-app-host", protocolVersion: 2, rendererId }, location.origin, [channel.port2]);
  channel.port1.postMessage({ type: "hello", protocolVersion: 2, rendererId });
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("App Host not ready")), 15000))]);
  const command = input => {
    const requestId = `${rendererId}:${++nextId}`;
    return wait(requestId, () => channel.port1.postMessage({ ...input, requestId }));
  };
  generation = (await command({ type: "host/connect", hostId: "local", leaseId })).generation;
  const rpc = (method, params = {}) => {
    const id = `rpc:${++nextId}`;
    return wait(id, () => { void command({ type: "host/send", hostId: "local", leaseId, generation, frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).catch(error => { pending.get(id)?.reject(error); pending.delete(id); }); });
  };
  await rpc("initialize");
  window.skillsAcceptance = { rpc, close: async () => { await command({ type: "host/disconnect", hostId: "local", leaseId, generation }); channel.port1.close(); } };
  return "Isolated desktop App Host client ready";
})()
