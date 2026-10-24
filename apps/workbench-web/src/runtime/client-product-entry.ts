import type { CreateWebWorkbenchApplicationOptions } from "./web-workbench-application";

/** Public clients keep local/remote Host functionality without a private product. */
export function clientProductOptions(_environment: Readonly<Record<string, unknown>>, _desktopKind?: string): CreateWebWorkbenchApplicationOptions {
  return {};
}
