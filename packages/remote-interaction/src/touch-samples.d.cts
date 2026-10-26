export interface TouchSample { time: number; touchPoints: unknown[]; }
export interface TouchMove extends TouchSample { type: 'touchMove'; history?: TouchSample[]; }
export const MAX_TOUCH_SAMPLES: number;
export const TOUCH_SAMPLE_WINDOW_MS: number;
export function mergeTouchMoves<T extends TouchMove>(previous: T, next: T): T;
