// DSH's lossless-JSON guard verifies realm intrinsics through the canonical
// native Function#toString representation. QuickJS exposes genuine Object
// and Array intrinsics with a different string form, so otherwise every plain
// record/array is incorrectly rejected as exotic. Spoof only these two exact
// intrinsic identities; user functions and every other callable stay intact.
export function installDshQuickJsCompatibility() {
  const original = Function.prototype.toString;
  const objectText = original.call(Object);
  const arrayText = original.call(Array);
  if (objectText === "function Object() { [native code] }" &&
      arrayText === "function Array() { [native code] }") return;
  Object.defineProperty(Function.prototype, "toString", {
    configurable: true,
    writable: true,
    value: function dshCompatibleFunctionToString() {
      if (this === Object) return "function Object() { [native code] }";
      if (this === Array) return "function Array() { [native code] }";
      return original.call(this);
    },
  });

  if (typeof globalThis.AbortSignal === "undefined") {
    class QuickJsAbortSignal {
      constructor() {
        this.aborted = false;
        this.reason = undefined;
        this.listeners = new Set();
      }

      addEventListener(type, listener, options = {}) {
        if (type !== "abort" || typeof listener !== "function") return;
        this.listeners.add({ listener, once: options?.once === true });
      }

      removeEventListener(type, listener) {
        if (type !== "abort") return;
        for (const entry of this.listeners) {
          if (entry.listener === listener) this.listeners.delete(entry);
        }
      }

      throwIfAborted() {
        if (this.aborted) throw this.reason ?? new Error("This operation was aborted");
      }

      _abort(reason) {
        if (this.aborted) return;
        this.aborted = true;
        this.reason = reason ?? new Error("This operation was aborted");
        for (const entry of [...this.listeners]) {
          entry.listener.call(this, { type: "abort", target: this });
          if (entry.once) this.listeners.delete(entry);
        }
      }

      static abort(reason) {
        const signal = new QuickJsAbortSignal();
        signal._abort(reason);
        return signal;
      }

      static any(signals) {
        const result = new QuickJsAbortSignal();
        for (const signal of signals) {
          if (signal.aborted) {
            result._abort(signal.reason);
            break;
          }
          signal.addEventListener("abort", () => result._abort(signal.reason), { once: true });
        }
        return result;
      }
    }

    class QuickJsAbortController {
      constructor() {
        this.signal = new QuickJsAbortSignal();
      }

      abort(reason) {
        this.signal._abort(reason);
      }
    }

    globalThis.AbortSignal = QuickJsAbortSignal;
    globalThis.AbortController = QuickJsAbortController;
  }
}
