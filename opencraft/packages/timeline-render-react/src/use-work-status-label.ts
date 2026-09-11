import {
  deriveWorkStatusLabel,
  type WorkStatusItem,
} from "@opencraft/chat-core";
import { useEffect, useState } from "react";

/** A display clock only: mounting, ticking and unmounting cannot change work facts. */
export function useWorkStatusLabel(item: WorkStatusItem, locale = "en") {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (item.status !== "working" || item.completedAtMs !== null) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [item.status, item.completedAtMs]);
  return deriveWorkStatusLabel(item, nowMs, locale);
}
