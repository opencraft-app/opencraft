import identity from "./product-identity.json" with { type: "json" };

export interface DesktopProductIdentity {
  readonly displayName: string;
  readonly profileDirectoryName: string;
  readonly legacyProfileDirectoryNames: readonly string[];
  readonly legacyDaemonName?: string;
  readonly applicationId: string;
}

/** Branding is not the identity of an existing user's profile or installation. */
export const desktopProduct: DesktopProductIdentity = Object.freeze(identity.production);

export const desktopPreviewProduct: DesktopProductIdentity = Object.freeze(identity.preview);

export function resolveDesktopProduct(packagedProductName: string): DesktopProductIdentity {
  return packagedProductName === desktopPreviewProduct.displayName ? desktopPreviewProduct : desktopProduct;
}
