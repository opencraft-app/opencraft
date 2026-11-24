/**
 * Composition-root ports that assembly modules receive instead of reading the
 * root's mutable bindings.
 *
 * `createHeadlessLifecycle` owns the one shutdown promise. `closing()` turns
 * true at the same moment the first `shutdown` call publishes that promise,
 * before any disposer runs, so authorization closures refuse new work from
 * then on.
 *
 * `createLateBinding` names a value that is constructed after the closures that
 * read it. The root binds it exactly once, where the value is constructed;
 * `get()` fails clearly before that, and `current()` keeps the "not yet"
 * answer (`undefined`) for readers that already tolerate it.
 */
export function createHeadlessLifecycle() {
  let shutdown = null;
  return Object.freeze({
    closing: () => shutdown !== null,
    /** Runs `dispose` once, asynchronously; every call returns the same promise. */
    shutdown(dispose) {
      shutdown ??= Promise.resolve().then(dispose);
      return shutdown;
    },
  });
}

export function createLateBinding(name) {
  let bound = false;
  let value;
  return Object.freeze({
    bind(next) {
      if (bound) throw new Error(`${name} is already bound`);
      bound = true;
      value = next;
      return next;
    },
    get() {
      if (!bound) throw new Error(`${name} is not available yet`);
      return value;
    },
    current: () => value,
  });
}
