/** Shared input geometry, independent of the host's native recognizer. */
export const EDGE_GESTURE_GUTTER = 24;
export type GestureEdge = "left" | "right";

interface Handoff {
  readonly edge: GestureEdge;
  readonly lifetime: { active: boolean };
}
const contacts = new WeakMap<Event, Handoff>();

/** An adapter hands the original contact to application gesture arbitration.
 * This carries input ownership, never a sidebar action or host identity.
 */
export function createEdgeGestureBridge() {
  const lifetime = { active: true };
  return {
    handoff(event: Event, edge: GestureEdge): void {
      if (lifetime.active) contacts.set(event, { edge, lifetime });
    },
    dispose(): void { lifetime.active = false; },
  };
}

export function readEdgeGestureHandoff(event: Event): GestureEdge | undefined {
  const contact = contacts.get(event);
  return contact?.lifetime.active ? contact.edge : undefined;
}
