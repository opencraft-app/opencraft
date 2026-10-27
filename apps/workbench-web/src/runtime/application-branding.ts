import { SingleContributionRegistry } from "@opencraft/extension-runtime";
import { isApplicationBranding, type ApplicationBrandingContribution } from "@opencraft/extension-contract";
import { applicationBrandingMetadata, APPLICATION_BRANDING_META_SELECTOR } from "./application-branding-metadata";
import { serverUrl } from "./server-context";
export class ApplicationBrandingRegistry extends SingleContributionRegistry<ApplicationBrandingContribution> {
  constructor() { super("application branding", isApplicationBranding); }
}
/** One effect owns document links; disposing restores the previous document owner. */
export function applyApplicationBranding(document: Document, brand: ApplicationBrandingContribution): () => void {
  const previous = Array.from(document.head.querySelectorAll<HTMLElement>(
    `link[rel="icon"], link[rel="manifest"], link[rel="apple-touch-icon"], link[rel="image_src"], ${APPLICATION_BRANDING_META_SELECTOR}`,
  ));
  previous.forEach(link => link.remove());
  const links: HTMLLinkElement[] = [];
  for (const [rel, href] of [["icon", brand.faviconUrl], ["manifest", brand.manifestUrl], ["apple-touch-icon", brand.appleTouchIconUrl]]) {
    if (!href) continue;
    const link = document.createElement("link"); link.rel = rel!; link.href = serverUrl(href);
    // Protected deployments authenticate even same-origin manifest requests.
    // Set this before insertion so Chrome includes the gateway session cookie.
    if (rel === "manifest") link.crossOrigin = "use-credentials";
    document.head.append(link); links.push(link);
  }
  const metadata = applicationBrandingMetadata(brand).map(({ attribute, key, content }) => {
    const meta = document.createElement("meta");
    meta.setAttribute(attribute, key); meta.content = content;
    document.head.append(meta);
    return meta;
  });
  if (brand.share !== undefined) {
    const link = document.createElement("link"); link.rel = "image_src";
    link.href = new URL(brand.share.imageUrl, brand.share.publicOrigin).href;
    document.head.append(link); links.push(link);
  }
  return () => { [...links, ...metadata].forEach(node => node.remove()); previous.forEach(node => document.head.append(node)); };
}
