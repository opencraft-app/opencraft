import { useIntl } from "@opencraft/i18n/react";
import { mobileMessages } from "../runtime/mobile-messages";
import { useEffect, useRef } from "react";
import { parseMobileContainerRequest } from "@opencraft/client-product/mobile-container";
import type { MobileContentSource } from "../runtime/content-source";
export function WorkspaceSurface({ source, onAppearance, onReady }: { source: MobileContentSource; dark: boolean; onAppearance(value: { resolvedTheme: "light" | "dark"; edgeBackgroundColor: string }): void; onReady(value: boolean): void; onSourceSettings(): void }) {
  const intl = useIntl();
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (source.kind !== "bundled") return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== location.origin || event.data?.type !== "opencraft-mobile-appearance") return;
      const message = parseMobileContainerRequest(JSON.stringify({ ...event.data, version: 1, runtimeId: "web-preview", type: "appearance" }), "web-preview");
      if (message?.type === "appearance") onAppearance(message);
    };
    window.addEventListener("message", receive); return () => window.removeEventListener("message", receive);
  }, [source, onAppearance]);
  return <iframe ref={frame} name="opencraft-mobile-preview" title={intl.formatMessage(mobileMessages.brand)} src={source.kind === "self-hosted" ? source.url : "/mobile-workbench.html"}
    sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerPolicy="no-referrer"
    style={{ flex: 1, width: "100%", height: "100%", border: 0 }} />;
}
