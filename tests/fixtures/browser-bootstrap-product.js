// Intentionally newer standard APIs at module evaluation time: the embedded
// loader must install shims before evaluating trusted product dependencies.
const pages = new Map([["tab", { pageId: "page-1" }]]).values().map(tab => tab.pageId).toArray();
const { promise, resolve } = Promise.withResolvers();
resolve(7);
const native = globalThis.compatNative;
customElements.define("opencraft-compatibility-fixture", class extends HTMLElement {});
globalThis.fixtureResult = {
  pages,
  grouped: Object.groupBy([1, 2, 3], n => n % 2)[1],
  mapGrouped: Map.groupBy([1, 2, 3], n => n % 2).get(0),
  union: [...new Set([1]).union(new Set([2]))],
  resolved: await promise,
  nativeMapRetained: !native.map || native.map === Iterator.prototype.map,
  nativePromiseRetained: !native.withResolvers || native.withResolvers === Promise.withResolvers,
  registered: !!customElements.get("opencraft-compatibility-fixture"),
};
