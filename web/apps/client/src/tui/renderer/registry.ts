type Handler = (payload: Record<string, unknown>) => unknown;

interface Binding {
  callback: Handler;
  id: string;
}

export class HandlerRegistry {
  private readonly bindings = new WeakMap<object, Map<string, Binding>>();
  private readonly handlers = new Map<string, Handler>();
  private mounted: Set<string> | null = null;
  private nextID = 1;

  public beginCommit(): void {
    this.mounted = new Set<string>();
  }

  public bind(owner: object, property: string, callback: Handler): string {
    let ownerBindings = this.bindings.get(owner);
    if (!ownerBindings) {
      ownerBindings = new Map<string, Binding>();
      this.bindings.set(owner, ownerBindings);
    }
    const current = ownerBindings.get(property);
    const binding =
      current?.callback === callback && this.handlers.has(current.id)
        ? current
        : {callback, id: `handler-${this.nextID++}`};
    ownerBindings.set(property, binding);
    this.handlers.set(binding.id, callback);
    this.mounted?.add(binding.id);
    return binding.id;
  }

  public endCommit(): void {
    const mounted = this.mounted;
    if (!mounted) return;
    for (const id of this.handlers.keys()) {
      if (!mounted.has(id)) this.handlers.delete(id);
    }
    this.mounted = null;
  }

  public dispatch(id: string, payload: Record<string, unknown>): boolean {
    const handler = this.handlers.get(id);
    if (!handler) return false;
    handler(payload);
    return true;
  }
}
