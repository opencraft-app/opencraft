import { useEffect, useRef, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { LiquidGlassBackdrop } from "@opencraft/design-system-web/liquid-glass";
import { Button } from "../ui/button";
import { useAppearanceTheme } from "../../appearance-theme";
import type { AnnouncementDialogContentProps } from "./announcement-dialog";
import "./announcement-experience.scss";

/** Same application document, with a frame-local mobile presentation. */
export function AnnouncementExperience({ announcement, onAction }: AnnouncementDialogContentProps) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const path = announcement.preview!.path;
  const title = announcement.titleMessage ? intl.formatMessage(announcement.titleMessage) : announcement.title;
  const text = (id: string, defaultMessage: string) =>
    intl.formatMessage({ id: "mobileExperience." + id, defaultMessage });
  const sendTheme = () =>
    frame.current?.contentWindow?.postMessage(
      {
        type: "opencraft.preview.appearance",
        preference: appearance.preference,
        themeId: appearance.requestedThemeId,
      },
      location.origin,
    );
  const sendCurrent = useRef(sendTheme);
  sendCurrent.current = sendTheme;
  useEffect(() => {
    sendCurrent.current();
  }, [appearance]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "opencraft.preview.ready") sendCurrent.current();
      if (event.data?.type === "opencraft.preview.escape") {
        // The existing ModalHost remains the sole dismissal/focus owner.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <article className="announcement-experience">
      <section className="announcement-experience__details">
        <LiquidGlassBackdrop shape="rounded-rectangle" />
        <header>
          <span className="announcement-experience__eyebrow">{text("showCode", "Scan on phone")}</span>
          <h2>{title}</h2>
          <p>{announcement.bodyMessage ? intl.formatMessage(announcement.bodyMessage) : announcement.body}</p>
        </header>
        {announcement.media ? (
          <div className="announcement-experience__qr">
            <img src={announcement.media.url} alt={text("qrLabel", "Workspace QR code")} />
          </div>
        ) : null}
        <div className="announcement-experience__actions">
          {announcement.primaryAction ? (
            <Button variant="outline" onClick={() => onAction(announcement.primaryAction!.id)}>
              {announcement.primaryAction.labelMessage
                ? intl.formatMessage(announcement.primaryAction.labelMessage)
                : announcement.primaryAction.label}
            </Button>
          ) : null}
          {announcement.secondaryAction ? (
            <Button variant="ghost" onClick={() => onAction(announcement.secondaryAction!.id)}>
              {announcement.secondaryAction.labelMessage
                ? intl.formatMessage(announcement.secondaryAction.labelMessage)
                : announcement.secondaryAction.label}
            </Button>
          ) : null}
        </div>
      </section>
      <section className="announcement-experience__stage" aria-label={text("backToPreview", "Phone preview")}>
        <LiquidGlassBackdrop shape="rounded-rectangle" />
        <header className="announcement-experience__preview-heading">
          <span>{text("backToPreview", "Phone preview")}</span>
          <p>{text("gestureHint", "Drag left or right to use the sidebar.")}</p>
        </header>
        <div className="announcement-experience__phone" aria-busy={!loaded}>
          {!loaded ? (
            <div className="announcement-experience__loading" role="status">
              {intl.formatMessage({ id: "common.loading", defaultMessage: "Loading…" })}
            </div>
          ) : null}
          <iframe
            ref={frame}
            src={path}
            title={text("backToPreview", "Phone preview")}
            data-opencraft-preview="mobile"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write; microphone; camera; fullscreen; display-capture"
            onLoad={() => {
              setLoaded(true);
              sendCurrent.current();
            }}
          />
        </div>
        <p className="announcement-experience__caption">
          {text("previewHint", "Try the mobile layout here. Actions affect your current workspace.")}
        </p>
      </section>
    </article>
  );
}
