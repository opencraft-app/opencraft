import { digest, requireText } from "./values.mjs";
export function memoryProjectSlug(raw) {
  requireText(raw, "project slug", 48);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw))
    throw new Error("Project slug must be a safe kebab-case name");
  return raw;
}
export function memoryView(value = null) {
  if (value && typeof value === "object")
    return {
      ...value,
      projectIds: [
        ...new Set(
          value.projectIds ?? (value.projectId ? [value.projectId] : []),
        ),
      ],
    };
  return { projectId: value, projectIds: value ? [value] : [] };
}
export const projectGrantId = (slug) => `memory.project/${slug}`;
export const projectGrantBinding = (identity, grant) =>
  digest([identity, grant]);
export function selectProjectMemories(blocks, cap = 3) {
  const latest = (b) =>
    Math.max(
      0,
      ...b.profile.map((m) => m.createdAt),
      ...b.recent.map((m) => m.createdAt),
    );
  const has = (b) => Number(b.profile.length + b.recent.length > 0);
  const ordered = [...blocks].sort(
    (a, b) =>
      has(b) - has(a) || latest(b) - latest(a) || a.slug.localeCompare(b.slug),
  );
  return {
    injected: ordered.slice(0, cap),
    alsoMemberOf: ordered.slice(cap).map(({ slug, name }) => ({ slug, name })),
  };
}
