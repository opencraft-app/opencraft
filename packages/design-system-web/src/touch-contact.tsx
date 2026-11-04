import { createContext, useContext, useMemo, type ReactNode } from "react";

export type TouchContactOrigin = "editor" | "menu" | "microphone";

export interface TouchContact {
  readonly id: number;
  readonly origin: TouchContactOrigin;
  readonly startedAt: number;
}

/**
 * One scoped physical contact owner for the Composer.  It deliberately does
 * not classify clicks or gestures; the browser and each feature own that
 * decision.  It only prevents two Composer features from arming the same
 * contact and provides one retirement path when native touch delivery ends.
 */
export class TouchContactCoordinator {
  #active: TouchContact | null = null;

  get active(): TouchContact | null { return this.#active; }

  claim(id: number, origin: TouchContactOrigin, startedAt = Date.now()): boolean {
    if (this.#active !== null && this.#active.id !== id) return false;
    if (this.#active === null) this.#active = { id, origin, startedAt };
    return this.#active.origin === origin;
  }

  owns(id: number, origin?: TouchContactOrigin): boolean {
    return this.#active?.id === id && (origin === undefined || this.#active.origin === origin);
  }

  release(id?: number): void {
    if (id === undefined || this.#active?.id === id) this.#active = null;
  }

  cancel(id?: number): void { this.release(id); }
}

const TouchContactContext = createContext<TouchContactCoordinator | null>(null);

export function TouchContactScope({ children }: { children: ReactNode }) {
  const coordinator = useMemo(() => new TouchContactCoordinator(), []);
  return <TouchContactContext.Provider value={coordinator}>{children}</TouchContactContext.Provider>;
}

/** Returns the nearest Composer scope, or null for ordinary standalone menus. */
export function useTouchContactScope(): TouchContactCoordinator | null {
  return useContext(TouchContactContext);
}
