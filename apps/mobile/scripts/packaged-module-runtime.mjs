/** Serialized into the packaged document. No network code fallback in native. */
export function startPackagedModules(manifest) {
  const modules = new Map();
  const requests = new Map();
  let sequence = 0;
  const identity = window.opencraftMobile;
  window.__opencraftPackagedReceive = message => {
    if (!identity || message.runtimeId !== identity.runtimeId) return;
    const request = requests.get(message.requestId);
    if (!request || request.resourceId !== message.resourceId) return;
    requests.delete(message.requestId);
    clearTimeout(request.timer);
    if (typeof message.text === "string") request.resolve(message.text);
    else request.reject(new Error("Packaged resource unavailable"));
  };
  const read = resourceId => {
    if (identity && window.ReactNativeWebView) return new Promise((resolve, reject) => {
      const requestId = String(++sequence);
      const timer = setTimeout(() => {
        requests.delete(requestId);
        reject(new Error("Packaged resource timed out"));
      }, 60000);
      requests.set(requestId, { resourceId, resolve, reject, timer });
      window.ReactNativeWebView.postMessage(JSON.stringify({ ...identity, type: "resource", requestId, resourceId }));
    });
    // Browser-only validation adapter; native always reads its packaged assets.
    return fetch(`./mobile-resources/${resourceId}.ocasset`).then(response => {
      if (!response.ok) throw new Error("Packaged resource unavailable");
      return response.text();
    });
  };
  const load = id => {
    if (modules.has(id)) return modules.get(id);
    if (typeof id !== "string" || !Object.hasOwn(manifest.modules, id)) return Promise.reject(new Error("Unknown packaged module"));
    const definition = manifest.modules[id];
    const result = (async () => {
      const [text, imports] = await Promise.all([
        read(definition.resourceId),
        Promise.all(definition.imports.map(async ([token, child]) => [token, await load(child)])),
      ]);
      let source = text;
      for (const [token, uri] of imports) source = source.split(token).join(uri);
      return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    })();
    modules.set(id, result);
    result.catch(() => modules.delete(id));
    return result;
  };
  window.__opencraftPackagedImport = async id => import(await load(id));
  window.__opencraftPackagedImport(manifest.entry).catch(error => {
    console.error("Packaged Workbench startup failed", error);
    if (identity && window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ ...identity, type: "startup-error" }));
    window.dispatchEvent(new Event("opencraft-packaged-error"));
  });
}
