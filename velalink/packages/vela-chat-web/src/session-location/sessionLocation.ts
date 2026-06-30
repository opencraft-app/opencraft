export type SessionLocationKind = "local_folder";

export interface SessionLocationInfo {
  kind: SessionLocationKind;
  label: string;
  path: string;
  ariaLabel: string;
}

export function buildSessionLocationInfo(
  workingDirectory: string | null | undefined,
): SessionLocationInfo | null {
  const path = workingDirectory?.trim();
  if (!path) return null;

  const label = locationLabelFromPath(path);
  return {
    ariaLabel: `位置：${label}`,
    kind: "local_folder",
    label,
    path,
  };
}

function locationLabelFromPath(path: string) {
  const withoutTrailingSeparators = path.replace(/[\\/]+$/, "") || path;
  const parts = withoutTrailingSeparators.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? withoutTrailingSeparators;
}
