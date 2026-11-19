/** Presentation admission only: data/native tab ownership is initialized elsewhere.
 * Once admitted, retain through empty/closed states to preserve mounted frames. */
export function retainRightPanelPresentation(visited: boolean, demand: {
  readonly open: boolean; readonly tabCount: number; readonly hostActive: boolean;
}): boolean {
  return visited || demand.open || demand.tabCount > 0 || demand.hostActive;
}
