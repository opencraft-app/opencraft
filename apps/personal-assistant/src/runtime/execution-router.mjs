/** Routes by immutable execution ownership. Entries own only lazy process adapters. */
export class ExecutionRouter {
  constructor({ executions, factories }) {
    Object.assign(this, { executions, factories });
    this.instances = new Map();
    this.stopping = false;
  }
  async run(work, signal) {
    if (this.stopping) throw new Error("Execution router is suspending");
    const engine = this.executions.execution(work)?.harness;
    if (!Object.hasOwn(this.factories, engine))
      throw new Error("Unknown persisted execution harness");
    if (!this.instances.has(engine)) {
      const entry = {};
      entry.promise = Promise.resolve()
        .then(() => this.factories[engine]())
        .then((adapter) => (entry.adapter = adapter));
      this.instances.set(engine, entry);
    }
    const adapter = await this.instances.get(engine).promise;
    if (this.stopping) throw new Error("Execution router is suspending");
    return adapter.run(work, signal);
  }
  activeSessionCount() {
    return [...this.instances.values()].reduce(
      (n, e) => n + (e.adapter?.activeSessionCount() ?? 0),
      0,
    );
  }
  async suspendAll() {
    this.stopping = true;
    await Promise.all(
      [...this.instances.values()].map((e) =>
        e.promise.then(
          (adapter) => adapter.suspendAll(),
          () => {},
        ),
      ),
    );
  }
}
