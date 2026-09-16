const catalogChanges = new Set(["thread/started", "thread/name/updated", "thread/archived", "thread/unarchived", "thread/closed", "turn/started", "turn/completed"]);
export function changesThreadCatalog(method: string): boolean { return catalogChanges.has(method); }
