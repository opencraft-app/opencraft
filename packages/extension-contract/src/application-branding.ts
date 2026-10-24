/** Trusted product contribution; Shell owns geometry and document presentation. */
export const APPLICATION_BRANDING_CHANNEL = "applicationBranding";
export interface ApplicationBrandingContribution {
  readonly id: string;
  readonly name: string;
  readonly markUrl?: string;
  /** Defaults to true; desktop marks and document/install icons are unaffected. */
  readonly showMarkOnMobile?: boolean;
  readonly faviconUrl?: string;
  readonly manifestUrl?: string;
  readonly appleTouchIconUrl?: string;
  /** Public, product-owned metadata. Never derive this from private chat data. */
  readonly share?: {
    readonly publicOrigin: string;
    readonly imageUrl: string;
    readonly description: string;
  };
}
export const DEFAULT_APPLICATION_BRANDING: ApplicationBrandingContribution = Object.freeze({
  id: "opencraft.default", name: "OpenCraft", markUrl: "/opencraft-icon.svg", faviconUrl: "/opencraft-icon.svg",
});
export function isApplicationBranding(value: unknown): value is ApplicationBrandingContribution {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return [candidate.id, candidate.name].every(v => typeof v === "string" && v.trim().length > 0)
    && (candidate.showMarkOnMobile === undefined || typeof candidate.showMarkOnMobile === "boolean")
    && [candidate.markUrl, candidate.faviconUrl, candidate.manifestUrl, candidate.appleTouchIconUrl]
      .every(v => v === undefined || isAssetPath(v))
    && (candidate.share === undefined || isShareMetadata(candidate.share));
}

function isAssetPath(value: unknown): value is string {
  return typeof value === "string" && /^\/(?!\/)[^\\\s]*$/.test(value);
}

function isShareMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const share = value as Record<string, unknown>;
  if (!isAssetPath(share.imageUrl) || typeof share.description !== "string"
    || share.description.trim().length === 0 || typeof share.publicOrigin !== "string") return false;
  try {
    const origin = new URL(share.publicOrigin);
    return origin.protocol === "https:" && origin.origin === share.publicOrigin;
  } catch { return false; }
}
