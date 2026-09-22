export interface DesktopProductIdentity {
  readonly displayName: string;
  readonly profileDirectoryName: string;
  readonly legacyProfileDirectoryNames: readonly string[];
  readonly applicationId: string;
}

/** Branding is not the identity of an existing user's profile or installation. */
export const desktopProduct: DesktopProductIdentity = Object.freeze({
  displayName: "OpenCraft",
  // Stable product-owned identity. Legacy names are migration inputs only.
  profileDirectoryName: "OpenCraft",
  legacyProfileDirectoryNames: ["@vela/workbench-electron"],
  applicationId: "ai.lightvela.vela",
});

export const desktopPreviewProduct: DesktopProductIdentity = Object.freeze({
  displayName: "OpenCraft Preview",
  profileDirectoryName: "OpenCraft Preview",
  legacyProfileDirectoryNames: ["@vela/workbench-electron-preview"],
  applicationId: "ai.lightvela.vela.preview",
});

export function resolveDesktopProduct(packagedProductName: string): DesktopProductIdentity {
  return packagedProductName === desktopPreviewProduct.displayName ? desktopPreviewProduct : desktopProduct;
}
