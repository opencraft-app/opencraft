/** Stable action identity and personal intent are independent of current capacity. */
export function toolbarDockKey(scope: string, dock: string): string {
  return JSON.stringify([scope, dock]);
}

export function projectToolbarDock<T extends { readonly id: string }>(
  actions: readonly T[], preferred: readonly string[], capacity: number,
): { docked: T[]; overflow: T[] } {
  const byId = new Map(actions.map(action => [action.id, action]));
  const docked = [...new Set(preferred)].flatMap(id => {
    const action = byId.get(id);
    return action ? [action] : [];
  }).slice(0, Math.max(0, Math.floor(Number.isFinite(capacity) ? capacity : 0)));
  const visible = new Set(docked.map(action => action.id));
  return { docked, overflow: actions.filter(action => !visible.has(action.id)) };
}

/** Unknown/unavailable actions remain in personal intent for their next appearance. */
export function moveToolbarAction(order: readonly string[], id: string, before: string | null, dock: boolean): string[] {
  const next = order.filter(candidate => candidate !== id);
  if (dock) next.splice(before === null || !next.includes(before) ? next.length : next.indexOf(before), 0, id);
  return next;
}

export function toolbarDockCapacity(width: number, titleBudget: number, actionSize: number, fixedActions: number, maximum: number): number {
  return actionSize > 0 ? Math.max(0, Math.min(maximum, Math.floor((width - titleBudget) / actionSize) - fixedActions)) : 0;
}

export interface ConversationToolbarAvailability {
  readonly port?: unknown;
  readonly onRename?: unknown;
  readonly onSetPinned?: unknown;
  readonly onFork?: unknown;
  readonly onArchive?: unknown;
  readonly schedules?: unknown;
  readonly im?: unknown;
  readonly project?: unknown;
  readonly workspaceDirectory?: unknown;
}
export function conversationToolbarActionIds(source: ConversationToolbarAvailability): string[] {
  return [source.port && "link-tasks", source.onRename && "rename", source.onSetPinned && "pin",
    source.onFork && "fork", source.onArchive && "archive", source.schedules && "schedules",
    source.im && "im-sources", (source.project || source.workspaceDirectory) && "information"]
    .filter((id): id is string => typeof id === "string");
}
