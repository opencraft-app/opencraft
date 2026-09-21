globalThis.hypernodeHotCandidate = {
  slot: "evolution",
  revision: "baseline-20260826",
  apply(ctx) {
    ctx.effect(() => ctx.appServer.register("hypernode/evolution/ping", () => ({
      ok: true,
      revision: "baseline-20260826",
    })));
  },
};
