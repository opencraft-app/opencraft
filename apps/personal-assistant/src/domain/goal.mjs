import { requireText } from "./values.mjs";

export function goalTasks(raw, existing = []) {
  if (!Array.isArray(raw) || !raw.length || raw.length + existing.length > 32)
    throw new Error("A goal needs 1..32 bounded work items");
  const tasks = raw.map((t) => {
    if (!t || typeof t !== "object") throw new Error("Invalid goal task");
    const key = requireText(t.key, "task key", 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Invalid task key");
    const dependsOn = t.dependsOn ?? [];
    if (
      !Array.isArray(dependsOn) ||
      dependsOn.length > 31 ||
      new Set(dependsOn).size !== dependsOn.length
    )
      throw new Error("Invalid task dependencies");
    return {
      key,
      text: requireText(t.text, "task objective"),
      dependsOn,
      completion: t.completion,
    };
  });
  const keys = [...existing, ...tasks.map((t) => t.key)];
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate task key");
  const visiting = new Set(),
    done = new Set(existing),
    byKey = new Map(tasks.map((t) => [t.key, t]));
  function visit(key) {
    if (done.has(key)) return;
    if (visiting.has(key)) throw new Error("Cyclic task dependency");
    const task = byKey.get(key);
    if (!task) throw new Error("Unknown dependency key");
    visiting.add(key);
    for (const dep of task.dependsOn) visit(dep);
    visiting.delete(key);
    done.add(key);
  }
  for (const task of tasks) visit(task.key);
  return tasks;
}
export function goalLimits(priority = 1, maxParallel = 2) {
  if (
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 2 ||
    !Number.isInteger(maxParallel) ||
    maxParallel < 1 ||
    maxParallel > 8
  )
    throw new Error("Goal priority must be 0..2 and maxParallel 1..8");
  return { priority, maxParallel };
}
