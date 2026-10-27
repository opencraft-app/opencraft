export interface BrowserPermissionStore {
  read(): Record<string, boolean>;
  write(value: Record<string, boolean>): void;
}
/** Decisions are scoped to an exact storage partition, top-level origin and permission. */
export class BrowserPermissionPolicy {
  private readonly pending = new Map<string, Promise<boolean>>();
  private epoch = 0;
  constructor(private readonly store: BrowserPermissionStore,
    private readonly prompt: (origin: string, permission: string) => Promise<{ allow: boolean; remember: boolean }>) {}
  key(partition: string, origin: string, permission: string) { return JSON.stringify([partition, origin, permission]); }
  supported(permission: string) { return ["notifications", "geolocation", "camera", "microphone"].includes(permission); }
  check(partition: string, origin: string, permission: string) {
    return this.supported(permission) && this.store.read()[this.key(partition, origin, permission)] === true;
  }
  async request(partition: string, origin: string, permission: string, valid: () => boolean): Promise<boolean> {
    if (!this.supported(permission) || !valid()) return false;
    const key = this.key(partition, origin, permission), saved = this.store.read()[key];
    const epoch = this.epoch;
    if (saved !== undefined) return saved && valid();
    let request = this.pending.get(key);
    if (!request) {
      request = this.prompt(origin, permission).then(result => {
        if (!valid() || epoch !== this.epoch) return false;
        if (result.remember) this.store.write({ ...this.store.read(), [key]: result.allow });
        return result.allow;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, request);
    }
    return await request && valid() && epoch === this.epoch;
  }
  revoke(partition: string, origin: string) {
    this.epoch++;
    const decisions = this.store.read();
    for (const key of Object.keys(decisions)) {
      const [storedPartition, storedOrigin] = JSON.parse(key);
      if (storedPartition === partition && storedOrigin === origin) delete decisions[key];
    }
    this.store.write(decisions);
  }
  clearPartition(partition: string) {
    this.epoch++;
    this.store.write(Object.fromEntries(Object.entries(this.store.read()).filter(([key]) => JSON.parse(key)[0] !== partition)));
  }
}
