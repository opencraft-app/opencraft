export type EncodingBucket = 'fast' | 'slow';
export interface BucketParameters { fps: number; bitrate: number; }
export type BucketBounds = Record<EncodingBucket, BucketParameters>;
export type ProductionPlan = Record<EncodingBucket, BucketParameters & { allowed: boolean }>;
export const BUCKETS: readonly EncodingBucket[];
export const DEFAULT_BOUNDS: BucketBounds;
export function bucketBounds(value?: BucketBounds): BucketBounds;
export class AdaptiveInputWindow {
  readonly limit: number;
  readonly delay: number | null;
  readonly samples: number;
  observe(ms: number): void;
  reset(): void;
}
export class EncodingBuckets {
  constructor(bounds?: BucketBounds);
  plan(consumers: { bucket: EncodingBucket; fps: number; allowed: boolean; pressure: boolean; progress: boolean }[], now: number): ProductionPlan;
}
