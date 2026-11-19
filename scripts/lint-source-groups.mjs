/** Each typed worker owns one workspace's TypeScript service. Retaining services
 * for every workspace in one process exhausts memory on large convergence PRs. */
export function lintSourceGroups(files) {
  const groups = new Map();
  for (const file of files) {
    const parts = file.split("/");
    const key =
      ["apps", "packages", "plugins"].includes(parts[0]) && parts.length > 2
        ? parts.slice(0, 2).join("/")
        : "repository";
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  return [...groups.values()];
}
