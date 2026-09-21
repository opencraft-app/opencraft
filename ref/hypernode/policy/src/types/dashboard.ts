export interface DashboardUser extends Record<string, unknown> {
  username?: string;
  role?: string;
}

export interface DashboardField extends Record<string, unknown> {
  name?: string;
  type?: string;
}

export interface DashboardForm {
  id: string;
  title?: string;
  description?: string | null;
  submitLabel?: string;
  fields: DashboardField[] | ((user: DashboardUser) => DashboardField[]);
  visible?(user: DashboardUser): boolean;
  submit(user: DashboardUser, values: Record<string, unknown>): unknown;
}

export interface DashboardFormDescription {
  id: string;
  title: string;
  description: string | null;
  submitLabel: string;
  fields: DashboardField[];
}

export interface DashboardPort {
  register(form: DashboardForm): () => boolean;
  describe(user: DashboardUser): DashboardFormDescription[];
  submit(user: DashboardUser, id: string, values?: Record<string, unknown> | null): unknown;
}
