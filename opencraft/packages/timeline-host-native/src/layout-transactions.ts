import type { TurnRange } from "@opencraft/timeline-virtualizer";

export interface NativeContentMeasurementLease {
  readonly epoch: object;
  readonly lifetime: object;
  readonly node: object | null;
}

/** Native measurements belong to one content/width lifetime, never the latest callback. */
export class NativeContentMeasurementEpoch {
  #epoch: object = {};
  #lifetime: object = {};
  #active = true;
  #contentIdentity: string | null = null;
  #width: number | null = null;

  reconcile(contentIdentity: string, width: number | null): void {
    if (this.#contentIdentity !== contentIdentity
      || (this.#width === null) !== (width === null)
      || (width !== null && this.#width !== null && Math.abs(width - this.#width) > 0.5)) {
      this.#epoch = {};
      this.#contentIdentity = contentIdentity;
      this.#width = width;
    }
  }

  capture(node: object | null): NativeContentMeasurementLease {
    return { epoch: this.#epoch, lifetime: this.#lifetime, node };
  }

  accepts(lease: NativeContentMeasurementLease, node: object | null): boolean {
    return this.matchesLayout(lease) && lease.lifetime === this.#lifetime && lease.node === node;
  }

  matchesLayout(lease: NativeContentMeasurementLease): boolean {
    return this.#active && lease.epoch === this.#epoch;
  }

  activate(): void { this.#active = true; }

  invalidate(): void {
    this.#active = false;
    this.#lifetime = {};
  }
}

/** Two bounded windows with stable row identity; never mount the gap between them. */
export function createNativeTurnMountPlan(
  visible: TurnRange,
  measuringTarget: TurnRange | null,
  count: number,
): readonly number[] {
  const indices = new Set<number>();
  for (const range of [visible, measuringTarget]) {
    if (range === null) continue;
    for (let index = Math.max(0, range.startIndex); index < Math.min(count, range.endIndex); index++) {
      indices.add(index);
    }
  }
  return [...indices].sort((a, b) => a - b);
}

export type NativeTargetPositionStep =
  | { readonly type: "wait" }
  | { readonly type: "complete" }
  | { readonly type: "write"; readonly distancePx: number; readonly behavior: "instant" | "smooth" };

export function nativeTargetReadiness({
  targetExists, observedRowHeightPx, committedRowHeightPx, geometryCommitPending, anchorMeasured,
}: {
  readonly targetExists: boolean;
  readonly observedRowHeightPx: number | null;
  readonly committedRowHeightPx: number | undefined;
  readonly geometryCommitPending: boolean;
  readonly anchorMeasured: boolean;
}): "unavailable" | "pending" | "ready" {
  if (!targetExists) return "unavailable";
  return observedRowHeightPx !== null && committedRowHeightPx !== undefined
    && Math.abs(observedRowHeightPx - committedRowHeightPx) <= 0.5
    && !geometryCommitPending && anchorMeasured ? "ready" : "pending";
}

/** Semantic target geometry remains authoritative throughout native animation. */
export class NativeTargetPositionTransaction {
  #geometry: string | null = null;
  #distancePx: number | null = null;

  needsObservation(distancePx: number): boolean {
    return this.#distancePx !== null && Math.abs(distancePx - this.#distancePx) <= 2;
  }

  advance({ geometry, destinationDistancePx, physicalDistancePx, behavior }: {
    readonly geometry: string;
    readonly destinationDistancePx: number;
    readonly physicalDistancePx: number;
    readonly behavior: "instant" | "smooth";
  }): NativeTargetPositionStep {
    if (Math.abs(physicalDistancePx - destinationDistancePx) <= 2) return { type: "complete" };
    if (this.#geometry === geometry && this.#distancePx === destinationDistancePx) return { type: "wait" };
    const retargeting = this.#geometry !== null;
    this.#geometry = geometry;
    this.#distancePx = destinationDistancePx;
    return { type: "write", distancePx: destinationDistancePx, behavior: retargeting ? "instant" : behavior };
  }
}
