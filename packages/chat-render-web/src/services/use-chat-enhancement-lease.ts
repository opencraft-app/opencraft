import { useEffect, useRef, useState, type RefObject } from "react";

import type { ChatEnhancementService } from "./chat-enhancement-service";

export interface ChatEnhancementLease {
  readonly frameRef: RefObject<HTMLElement | null>;
  readonly granted: boolean;
}

/** React lease over the runtime-owned near-viewport observer. */
export function useChatEnhancementLease(
  service: ChatEnhancementService,
): ChatEnhancementLease {
  const frameRef = useRef<HTMLElement>(null);
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (granted || frameRef.current === null) return;
    return service.observeNearViewport(frameRef.current, () => setGranted(true));
  }, [granted, service]);
  return { frameRef, granted };
}
