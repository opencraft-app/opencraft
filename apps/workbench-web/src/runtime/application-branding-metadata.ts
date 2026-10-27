import type { ApplicationBrandingContribution } from "@opencraft/extension-contract";

/** Both initial HTML and the active plugin use the same public metadata. */
export function applicationBrandingMetadata(brand: ApplicationBrandingContribution) {
  const share = brand.share;
  if (share === undefined) return [];
  const image = new URL(share.imageUrl, share.publicOrigin).href;
  return [
    { attribute: "name", key: "description", content: share.description },
    { attribute: "property", key: "og:type", content: "website" },
    { attribute: "property", key: "og:site_name", content: brand.name },
    { attribute: "property", key: "og:title", content: brand.name },
    { attribute: "property", key: "og:description", content: share.description },
    { attribute: "property", key: "og:image", content: image },
    { attribute: "property", key: "og:image:alt", content: brand.name },
    { attribute: "name", key: "twitter:card", content: "summary" },
    { attribute: "name", key: "twitter:title", content: brand.name },
    { attribute: "name", key: "twitter:description", content: share.description },
    { attribute: "name", key: "twitter:image", content: image },
  ] as const;
}

export const APPLICATION_BRANDING_META_SELECTOR =
  'meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]';
