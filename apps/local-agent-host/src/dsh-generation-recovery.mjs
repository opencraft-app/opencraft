import { isDeepStrictEqual } from "node:util";

/** Recovery transaction survives native-create/flush before checkpoint commit. */
export async function recoverDshGeneration(store, input, ports) {
  return store.transition(input.logicalSessionId, async () => {
    let intent = await store.readIntent(input.logicalSessionId);
    if (intent && intent.input.sourceSessionId !== input.sourceSessionId) throw new Error("Generation intent source mismatch");
    if (!intent) {
      const prepared = await store.prepare(input.logicalSessionId, input.sourceSessionId, ports.readTail);
      if (!prepared) throw new Error("No checkpoint for requested logical session");
      await store.writeIntent(input, prepared);
      intent = { input, prepared };
    }
    const prepared = intent.prepared;
    const current = await store.read(input.logicalSessionId);
    const coordinates = {
      seedThroughSeq: prepared.seed.length - 1,
      seedThroughTurn: Math.max(0, ...prepared.seed.map(event => event.data?.turn ?? 0)),
    };
    if (current?.sourceSessionId === prepared.sessionId && current.generation === prepared.generation) {
      await store.clearIntent(input.logicalSessionId);
      return { ...prepared, ...coordinates, seed: undefined };
    }
    if (current?.sourceSessionId !== input.sourceSessionId) throw new Error("Checkpoint changed while generation creation was pending");
    const persisted = await ports.readExisting(prepared.sessionId);
    if (persisted) {
      const prefix = persisted.events.slice(0, prepared.seed.length);
      if (!isDeepStrictEqual(prefix, prepared.seed)) throw new Error("Unpublished native generation differs from durable creation intent");
    }
    const handle = persisted
      ? await ports.resume(prepared.sessionId, intent.input)
      : await ports.create(prepared, intent.input);
    try {
      await ports.flush(handle.agent.session);
      await store.capture(input.logicalSessionId, handle.agent.session, prepared.generation, ports.flush, coordinates);
      await ports.publish(prepared, handle);
      await store.clearIntent(input.logicalSessionId);
      return { sessionId: prepared.sessionId, generation: prepared.generation, interruptedTurns: prepared.interruptedTurns, ...coordinates };
    } catch (error) { await handle.dispose(); throw error; }
  });
}
