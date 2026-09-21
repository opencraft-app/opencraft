export function requiresDashboardAdminValidation(path: string[]): boolean {
  return path[0] === "shadow-bindings";
}
