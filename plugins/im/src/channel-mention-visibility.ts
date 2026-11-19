import { useEffect } from "react";
import type { ChannelMessage } from "@opencraft/appserver-protocol";
import type { ChannelsClient } from "./channel-client";

/** Only a foreground, visible mention can be acknowledged. Reading the latest
 * ordinary message is deliberately not a substitute for seeing an old @. */
export function useVisibleChannelMentions({
  viewport,
  messages,
  active,
  client,
  channelId,
  onAcknowledged,
}: {
  viewport: HTMLDivElement | null;
  messages: readonly ChannelMessage[] | null;
  active: boolean;
  client: ChannelsClient;
  channelId: string;
  onAcknowledged(messageId: string): void;
}) {
  useEffect(() => {
    const root = viewport;
    if (!root || !active || !messages?.length) return;
    const doc = root.ownerDocument,
      win = doc.defaultView!;
    const abort = new AbortController(),
      pending = new Set<string>();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const visible = (target: HTMLElement) => {
      if (doc.visibilityState !== "visible" || !doc.hasFocus() || root.closest('[inert],[hidden],[aria-hidden="true"]'))
        return false;
      const a = target.getBoundingClientRect(),
        b = root.getBoundingClientRect();
      const width = Math.min(a.right, b.right, win.innerWidth) - Math.max(a.left, b.left, 0),
        height = Math.min(a.bottom, b.bottom, win.innerHeight) - Math.max(a.top, b.top, 0);
      return a.width > 0 && a.height > 0 && width > 0 && height > 0 && (width * height) / (a.width * a.height) >= 0.6;
    };
    const read = (target: HTMLElement) => {
      const id = target.dataset.unreadMentionMessage;
      if (!id || pending.has(id) || !visible(target)) return;
      pending.add(id);
      void client
        .acknowledgeMention(channelId, id, abort.signal)
        .then((result) => {
          if (!abort.signal.aborted && result.acknowledged) onAcknowledged(id);
        })
        .catch(() => {
          if (!abort.signal.aborted && retry === undefined)
            retry = setTimeout(() => {
              retry = undefined;
              scan();
            }, 1500);
        })
        .finally(() => pending.delete(id));
    };
    const scan = () => {
      if (!abort.signal.aborted) root.querySelectorAll<HTMLElement>("[data-unread-mention-message]").forEach(read);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) read(entry.target as HTMLElement);
      },
      // Include the outer viewport: a route can slide in while the marker is
      // already intersecting its own scroller. Scroller-relative observation
      // alone never reports that visibility change.
      { threshold: [0, 0.6, 1] },
    );
    // Virtualized history mounts old entries without changing the message array.
    const observed = new WeakSet<HTMLElement>();
    const observeTargets = () => {
      root.querySelectorAll<HTMLElement>("[data-unread-mention-message]").forEach((target) => {
        if (!observed.has(target)) {
          observed.add(target);
          observer.observe(target);
        }
      });
      scan();
    };
    const mounts = new MutationObserver(observeTargets);
    mounts.observe(root, { childList: true, subtree: true });
    observeTargets();
    // Route transitions can remove an ancestor's inert/hidden state without
    // moving the marker relative to either intersection root.
    const activation = new MutationObserver(scan);
    for (let element: HTMLElement | null = root; element; element = element.parentElement) {
      activation.observe(element, {
        attributes: true,
        attributeFilter: ["inert", "hidden", "aria-hidden"],
      });
    }
    doc.addEventListener("visibilitychange", scan);
    win.addEventListener("focus", scan);
    scan();
    return () => {
      abort.abort();
      observer.disconnect();
      mounts.disconnect();
      activation.disconnect();
      clearTimeout(retry);
      doc.removeEventListener("visibilitychange", scan);
      win.removeEventListener("focus", scan);
    };
  }, [viewport, messages, active, client, channelId, onAcknowledged]);
}
