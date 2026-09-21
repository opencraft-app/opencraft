import { Context, Service } from "@deepseek-ai/cordis";
import type {
  DashboardForm,
  DashboardFormDescription,
  DashboardPort,
  DashboardUser,
} from "../types/dashboard.ts";

export class DashboardService extends Service implements DashboardPort {
  readonly forms = new Map<string, DashboardForm>();

  constructor(ctx: Context) {
    super(ctx, "dashboard");
  }

  register(form: DashboardForm): () => boolean {
    const fieldsValid = Array.isArray(form?.fields) || typeof form?.fields === "function";
    if (!form?.id || !fieldsValid || typeof form.submit !== "function") {
      throw new Error("invalid dashboard form registration");
    }
    if (this.forms.has(form.id)) throw new Error(`duplicate dashboard form: ${form.id}`);
    this.forms.set(form.id, form);
    return () => this.forms.delete(form.id);
  }

  describe(user: DashboardUser): DashboardFormDescription[] {
    return [...this.forms.values()].filter((form) => form.visible?.(user) !== false).map((form) => ({
      id: form.id,
      title: form.title ?? form.id,
      description: form.description ?? null,
      submitLabel: form.submitLabel ?? "提交",
      fields: typeof form.fields === "function" ? form.fields(user) : form.fields,
    }));
  }

  submit(user: DashboardUser, id: string, values?: Record<string, unknown> | null): unknown {
    const form = this.forms.get(id);
    if (!form) throw new Error(`unknown dashboard action ${JSON.stringify(id)}`);
    if (form.visible?.(user) === false) {
      throw new Error("dashboard action is not available for this user");
    }
    return form.submit(user, values ?? {});
  }
}
