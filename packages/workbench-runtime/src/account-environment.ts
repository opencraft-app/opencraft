export interface EnvironmentVariableView { name: string; value: string | null; secret: boolean }
export interface EnvironmentScope { projectId: string | null }
export interface EnvironmentView extends EnvironmentScope {
  revision: number; variables: EnvironmentVariableView[]; inherited: EnvironmentVariableView[];
}
export interface EnvironmentDocument extends EnvironmentView { projects: readonly { id: string; name: string }[] }
export function parseEnvironmentDocument(value: unknown): EnvironmentDocument {
  const raw = value as EnvironmentDocument | null;
  const rows = (items: unknown): items is EnvironmentVariableView[] => Array.isArray(items) && items.length <= 100 && items.every(item =>
    item && typeof item.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(item.name)
    && typeof item.secret === 'boolean' && (item.secret ? item.value === null : typeof item.value === 'string'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isSafeInteger(raw.revision) || raw.revision < 0
    || raw.projectId !== null && typeof raw.projectId !== 'string' || !rows(raw.variables) || !rows(raw.inherited)
    || !Array.isArray(raw.projects) || raw.projects.some(project => !project || typeof project.id !== 'string' || typeof project.name !== 'string')) throw new Error('invalid');
  return raw;
}
