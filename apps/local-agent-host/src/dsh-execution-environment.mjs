/** The generation routing/checkpoint owner supplies the only native→logical
 * resolver. Both shell facts and persistent terminals consume that same port. */
export function registerDshExecutionEnvironment(ctx, resolveLogicalThreadId) {
  const identity = Object.freeze({ resolve: nativeId => resolveLogicalThreadId(nativeId) });
  ctx.provide("opencraftExecutionThread", identity);
  ctx.inject(["shellEnv"], scoped => {
    scoped.shellEnv.register({
      name: "opencraft-execution-thread",
      variables: { DSH_OPENCRAFT_THREAD_ID: { description: "Stable public OpenCraft Thread ID for the current native execution." } },
      resolve(execution) {
        const nativeId = execution.agent?.session.header.id;
        return nativeId ? { DSH_OPENCRAFT_THREAD_ID: identity.resolve(String(nativeId)) } : {};
      },
    });
  });
}
