export const TEXT_DELTA_PACER_DEFAULTS: Record<string, number>;
export function splitGraphemes(value: string): string[];
export class TextDeltaPacerController {
  constructor(options: { emit: (metadata: any, delta: string) => void; now?: () => number; requestTick?: (delay: number) => void; options?: Record<string,number> });
  enqueue(metadata: any, delta: string): void;
  afterDrained(metadata: any, action: () => void): boolean;
  flush(metadata: any): boolean;
  tick(now?: number): void;
  diagnostics(): any;
  items: Map<string, any>;
  cadences: Map<string, any>;
}
