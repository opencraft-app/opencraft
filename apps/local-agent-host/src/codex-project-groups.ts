import { isAbsolute, relative } from "node:path";
import type { NativeConversationProject } from "@opencraft/appserver-protocol";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Read-only projection of the Codex desktop's local project membership. */
export function codexProjectGroups(value: unknown, threads: readonly { id: string; cwd: string }[]): Record<string, NativeConversationProject | null> {
  const state = object(value), projects = new Map<string, { group: NativeConversationProject; roots: string[] }>();
  const order = Array.isArray(state["project-order"]) ? state["project-order"] : [];
  const labels = object(state["electron-workspace-root-labels"]);
  for (const [key, raw] of Object.entries(object(state["local-projects"]))) {
    const p = object(raw);
    if (p.id !== key || !key || key.length > 512 || typeof p.name !== "string" || !p.name.trim() || p.name.length > 256 || !Array.isArray(p.rootPaths) || !p.rootPaths.length || !p.rootPaths.every(root => typeof root === "string" && isAbsolute(root))) continue;
    const position = order.indexOf(key);
    projects.set(key, { group: { source: "codex", id: key, name: p.name, position: position < 0 ? order.length + projects.size : position }, roots: p.rootPaths });
  }
  // Older Codex desktop state names projects by their saved workspace root.
  for (const root of Array.isArray(state["electron-saved-workspace-roots"]) ? state["electron-saved-workspace-roots"] : []) {
    if (typeof root !== "string" || root.length > 512 || !isAbsolute(root) || [...projects.values()].some(p => p.roots.includes(root))) continue;
    const name = typeof labels[root] === "string" ? labels[root] : root.split(/[\\/]/u).filter(Boolean).at(-1);
    if (!name || name.length > 256) continue;
    const position = order.indexOf(root);
    projects.set(root, { group: { source: "codex", id: root, name, position: position < 0 ? order.length + projects.size : position }, roots: [root] });
  }
  const assignments = object(state["thread-project-assignments"]);
  const projectless = new Set(Array.isArray(state["projectless-thread-ids"]) ? state["projectless-thread-ids"] : []);
  return Object.fromEntries(threads.map(thread => {
    if (projectless.has(thread.id)) return [thread.id, null];
    const assigned = object(assignments[thread.id]);
    // Explicit assignment wins over cwd, including an unknown/remote project.
    if (Object.hasOwn(assignments, thread.id)) return [thread.id, assigned.projectKind === "local" && typeof assigned.projectId === "string" ? projects.get(assigned.projectId)?.group ?? null : null];
    const matches = [...projects.values()].flatMap(p => p.roots.filter(root => {
      const child = relative(root, thread.cwd); return child === "" || (child !== ".." && !child.startsWith("../") && !isAbsolute(child));
    }).map(root => ({ group: p.group, length: root.length })));
    matches.sort((a, b) => b.length - a.length || a.group.position - b.group.position);
    return [thread.id, matches[0]?.group ?? null];
  }));
}
