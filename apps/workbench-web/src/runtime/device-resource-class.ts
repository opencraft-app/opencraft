import { isPrimaryPointerTouch } from "@opencraft/design-system-web/input-presentation";
import type { WorkbenchResourceClass } from "@opencraft/workbench-runtime";

/** Devices reporting at most this much memory (GiB) keep constrained caches. */
const CONSTRAINED_DEVICE_MEMORY_GIB = 4;

/**
 * Cache budgets follow device capacity, not touch presentation or the user's
 * touch-friendly preference. `navigator.deviceMemory` is the direct signal
 * where the engine exposes it. A handheld (touch primary pointer) stays
 * constrained regardless, because WebKit hides device memory and mobile
 * WebViews are reclaimed under pressure.
 */
export function resolveWorkbenchResourceClass(view: Window | undefined): WorkbenchResourceClass {
  if (!view) return "standard";
  const memory = (view.navigator as Navigator & { readonly deviceMemory?: number }).deviceMemory;
  if (typeof memory === "number" && memory <= CONSTRAINED_DEVICE_MEMORY_GIB) return "constrained";
  return typeof view.matchMedia === "function" && isPrimaryPointerTouch(view) ? "constrained" : "standard";
}
