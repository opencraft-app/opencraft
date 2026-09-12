interface WorkbenchBuildEnvironment {
  readonly VITE_OPENCRAFT_PRODUCT_ID?: string;
}

export function resolveWorkbenchProductId(
  environment: WorkbenchBuildEnvironment | undefined,
): string {
  return environment?.VITE_OPENCRAFT_PRODUCT_ID?.trim() || "opencraft";
}

/** Build identity is resolved once and consumed by every product-owned policy. */
export const workbenchProductId = resolveWorkbenchProductId(
  import.meta.env as WorkbenchBuildEnvironment | undefined,
);
