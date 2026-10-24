export interface NativeTurnMeasurementLease {
  readonly turnKey: string;
  readonly identity: symbol;
}

/** Matches Native layout callbacks to the currently mounted virtual row. */
export class NativeTurnMeasurementRegistry {
  readonly #current = new Map<string, NativeTurnMeasurementLease>();

  register(turnKey: string): NativeTurnMeasurementLease {
    const lease = { turnKey, identity: Symbol(turnKey) };
    this.#current.set(turnKey, lease);
    return lease;
  }

  isCurrent(lease: NativeTurnMeasurementLease): boolean {
    return this.#current.get(lease.turnKey) === lease;
  }

  filterCurrent<T extends { readonly lease: NativeTurnMeasurementLease }>(
    measurements: readonly T[],
  ): T[] {
    return measurements.filter(({ lease }) => this.isCurrent(lease));
  }

  retire(lease: NativeTurnMeasurementLease): boolean {
    if (!this.isCurrent(lease)) return false;
    this.#current.delete(lease.turnKey);
    return true;
  }

  clear(): void {
    this.#current.clear();
  }
}
