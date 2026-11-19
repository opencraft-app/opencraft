export const IOA_ACCESS_PATH = '/__opencraft_enterprise_identity/access-policy';
export type EmployeeAdmissionConfig =
  | { mode: 'inherit' }
  | { mode: 'allowlist'; loginNames: string[] }
  | { mode: 'javascript'; source: string };
export interface EmployeeAdmissionInput {
  server: { id: string };
  identity: { loginName: string; staffId: string };
}
export interface EmployeeAdmissionDocument {
  server: { id: string; name: string };
  canManage: boolean;
  revision?: number;
  active?: EmployeeAdmissionConfig;
  draft?: EmployeeAdmissionConfig;
  versions?: { revision: number; config: EmployeeAdmissionConfig; at: number }[];
}
export const employeeAdmissionExample = `function admit(input) {
  const names = ["employee.one", "employee.two"];
  return { allow: names.includes(input.identity.loginName.toLowerCase()) };
}`;
