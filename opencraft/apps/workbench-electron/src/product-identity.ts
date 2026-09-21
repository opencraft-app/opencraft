export interface DesktopProductIdentity {
  readonly displayName: string;
  readonly profileDirectoryName: string;
  readonly applicationId: string;
}

/** Branding is not the identity of an existing user's profile or installation. */
export const desktopProduct: DesktopProductIdentity = Object.freeze({
  displayName: "OpenCraft",
  // Stable on-disk identity. Never derive this from displayName/package.json.
  // Verified against the existing packaged app: Electron used package.name,
  // not electron-builder's display-only productName, for the profile path.
  profileDirectoryName: "@vela/workbench-electron",
  applicationId: "ai.lightvela.vela",
});

export const desktopPreviewProduct: DesktopProductIdentity = Object.freeze({
  displayName: "OpenCraft Preview",
  profileDirectoryName: "@vela/workbench-electron-preview",
  applicationId: "ai.lightvela.vela.preview",
});

export function resolveDesktopProduct(packagedProductName: string): DesktopProductIdentity {
  return packagedProductName === desktopPreviewProduct.displayName ? desktopPreviewProduct : desktopProduct;
}
