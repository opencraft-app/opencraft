/** Expo Go assets must retain a reverse proxy's manifest directory. */
export function mobilePreviewAssetUri(uri: string, experienceUrl: string | null | undefined): string {
  if (!experienceUrl) return uri;
  try {
    const manifest = new URL(experienceUrl.replace(/^exp:/u, "http:").replace(/^exps:/u, "https:"));
    const asset = new URL(uri);
    const prefix = manifest.pathname.split("/--/")[0]!.replace(/\/+$/u, "");
    if (!["http:", "https:"].includes(manifest.protocol) || asset.origin !== manifest.origin
      || !prefix || !asset.pathname.startsWith("/assets/")) return uri;
    asset.pathname = prefix + asset.pathname;
    return asset.href;
  } catch { return uri; }
}
