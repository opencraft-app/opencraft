interface PageLinkShareTarget {
  share?(data: ShareData): Promise<void>;
  canShare?(data: ShareData): boolean;
  readonly clipboard?: Pick<Clipboard, "writeText">;
}

export type SharePageLinkOutcome = "shared" | "copied" | "cancelled";

/** Call from the original click handler: Web Share requires transient activation. */
export async function sharePageLink(data: { readonly url: string; readonly title?: string }, target: PageLinkShareTarget = navigator): Promise<SharePageLinkOutcome> {
  const url = new URL(data.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported page URL");
  const payload = { url: url.href, ...(data.title ? { title: data.title } : {}) };
  if (typeof target.share === "function" && (typeof target.canShare !== "function" || target.canShare(payload))) {
    try {
      await target.share(payload);
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      throw error;
    }
  }
  if (!target.clipboard) throw new Error("Clipboard is unavailable");
  await target.clipboard.writeText(url.href);
  return "copied";
}
