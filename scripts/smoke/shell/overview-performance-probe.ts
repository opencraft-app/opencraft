/** Test-only whole-interaction probe. Installed before application observers are
 * created, so microtasks and observer work after onUpdate remain visible. */
export function installOverviewPerformanceProbe() {
  const w = window as any;
  let scope:
    { kind: string; reads: number; layoutReads: number; styleReads: number; forcedDocumentWidths: number } | undefined;
  const probe = (w.overviewPerformance = {
    records: [] as any[],
    progress: undefined as number | undefined,
    run<T>(kind: string, callback: () => T): T {
      if (!w.captureSceneCadence) return callback();
      const parent = scope,
        current = { kind, reads: 0, layoutReads: 0, styleReads: 0, forcedDocumentWidths: 0 },
        at = performance.now();
      scope = current;
      try {
        return callback();
      } finally {
        probe.records.push({ ...current, at, duration: performance.now() - at, progress: probe.progress });
        scope = parent;
      }
    },
  });
  const read = (style = false) => {
    if (!scope) return;
    scope.reads++;
    if (style) scope.styleReads++;
    else scope.layoutReads++;
  };
  for (const prototype of [Element.prototype, Range.prototype]) {
    for (const name of ["getBoundingClientRect", "getClientRects"] as const) {
      const original = prototype[name];
      (prototype[name] as any) = function (this: Element & Range, ...args: any[]) {
        read();
        return (original as any).apply(this, args);
      };
    }
  }
  for (const prototype of [Element.prototype, HTMLElement.prototype]) {
    for (const name of [
      "offsetWidth",
      "offsetHeight",
      "offsetTop",
      "offsetLeft",
      "clientWidth",
      "clientHeight",
      "scrollWidth",
      "scrollHeight",
      "scrollTop",
      "scrollLeft",
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor?.get || !descriptor.configurable) continue;
      const get = descriptor.get;
      Object.defineProperty(prototype, name, {
        ...descriptor,
        get() {
          read();
          if (scope && name === "offsetWidth" && this === document.documentElement) scope.forcedDocumentWidths++;
          return get.call(this);
        },
      });
    }
  }
  for (const name of ["innerWidth", "innerHeight"]) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    if (!descriptor?.get || !descriptor.configurable) continue;
    const get = descriptor.get;
    Object.defineProperty(window, name, {
      ...descriptor,
      get() {
        read();
        return get.call(window);
      },
    });
  }
  const css = window.getComputedStyle;
  window.getComputedStyle = (...args) => {
    read(true);
    return css(...args);
  };
  const microtask = window.queueMicrotask;
  window.queueMicrotask = (callback) => microtask(() => probe.run("microtask:" + callback.name, callback));
  const Mutation = window.MutationObserver,
    Resize = window.ResizeObserver;
  window.MutationObserver = class extends Mutation {
    constructor(callback: MutationCallback) {
      super((records, observer) => probe.run("mutation:" + callback.name, () => callback(records, observer)));
    }
  };
  window.ResizeObserver = class extends Resize {
    constructor(callback: ResizeObserverCallback) {
      super((records, observer) => probe.run("resize:" + callback.name, () => callback(records, observer)));
    }
  };
}
