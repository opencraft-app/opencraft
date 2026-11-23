// Ordered test cleanup. node:test runs `t.after` hooks in registration order
// and skips the remaining ones once a hook throws. A test that registers
// `rm(root)` before `server.close()` therefore removes the data root while the
// server still writes to it (ENOTEMPTY), and the failed hook skips the close,
// leaving listeners, Workers and timers alive so the test file never exits.
//
// `ownedCleanup(t)` registers one hook instead: resources registered with
// `own` close newest first, each awaited even if another fails; then the
// removals registered with `last` run in registration order; errors are
// rethrown together.
export function ownedCleanup(t) {
  const resources = [];
  const removals = [];
  t.after(async () => {
    const errors = [];
    for (const cleanup of resources.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const removal of removals) {
      try {
        await removal();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "test cleanup failed");
  });
  return {
    /** A resource to close before any removal; closes run newest first. */
    own(cleanup) {
      resources.push(cleanup);
    },
    /** A removal (for example the test's data root) that runs after every resource closed. */
    last(removal) {
      removals.push(removal);
    },
  };
}
