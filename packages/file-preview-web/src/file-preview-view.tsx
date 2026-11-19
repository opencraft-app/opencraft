import { createPortal } from "react-dom";
import { useContext, useEffect, useState, useRef, useSyncExternalStore, useCallback, useMemo } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { FilePreviewError } from "@opencraft/file-preview-core";
import type { WebPreviewDocument, FilePreviewInput } from "./index";
import type { PreviewLease } from "@opencraft/file-preview-core";
import { PreviewContext } from "./index";
import previewBaseStyles from "./preview.web.scss?inline";
export function FilePreviewView(
  props: FilePreviewInput & {
    active?: boolean;
    download?: boolean;
    dark: boolean;
    onOpenLink?(url: string): void;
    prepare(signal?: AbortSignal): Promise<void>;
  },
) {
  const service = useContext(PreviewContext);
  const intl = useIntl();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    request: object;
    lease?: PreviewLease<WebPreviewDocument>;
    failure?: unknown;
  } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { ownerId, tabId, resource, blob, name, prepare } = props;
  const request = useMemo(() => ({}), [service, ownerId, tabId, resource, blob, name, attempt, prepare]);
  const lease = result?.request === request ? (result.lease ?? null) : null;
  const failed = result?.request === request && result.failure;
  useEffect(() => {
    let active = true;
    let acquired: PreviewLease<WebPreviewDocument> | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    void prepare(controller.signal)
      .then(() => {
        if (!active) return;
        acquired = service?.acquire({ ownerId, tabId, resource, blob, name }, attempt);
        if (!acquired) throw new Error("Preview service unavailable");
        setResult({ request, lease: acquired });
      })
      .catch((error) => {
        if (active)
          setResult({ request, failure: controller.signal.aborted ? new FilePreviewError("timeout") : error });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
      acquired?.release();
    };
  }, [service, ownerId, tabId, resource, blob, name, attempt, prepare, request]);
  const subscribe = useCallback((listener: () => void) => lease?.subscribe(listener) ?? (() => {}), [lease]);
  const getSnapshot = useCallback(() => lease?.getSnapshot() ?? null, [lease]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const document = snapshot?.phase === "ready" ? snapshot.document : null;
  useEffect(() => {
    if (!document || !root.current) return;
    const container = root.current;
    container.replaceChildren(document.element);
    return () => {
      document.setActive?.(false);
      document.element.remove();
    };
  }, [document]);
  useEffect(() => {
    document?.setActive?.(props.active !== false);
  }, [document, props.active]);
  useEffect(() => {
    document?.setTheme?.(props.dark);
  }, [document, props.dark]);
  useEffect(() => {
    document?.setIntl?.(intl);
  }, [document, intl]);
  useEffect(() => {
    document?.setOpenLink?.(props.onOpenLink);
    return () => document?.setOpenLink?.(undefined);
  }, [document, props.onOpenLink]);
  const reason = snapshot?.phase === "failed" ? snapshot.error : failed;
  const error = failed || snapshot?.phase === "failed" || snapshot?.phase === "released";
  const errorMessage =
    reason instanceof FilePreviewError
      ? {
          "too-large": {
            id: "preview.tooLarge",
            defaultMessage: "This file is too large to preview (25 MB limit). Download it to view.",
          },
          encrypted: {
            id: "preview.encrypted",
            defaultMessage: "Password-protected files cannot be previewed. Download it to open with its password.",
          },
          invalid: {
            id: "preview.invalid",
            defaultMessage:
              "This file is damaged or its contents do not match the format. Download the original to check it.",
          },
          timeout: {
            id: "preview.timeout",
            defaultMessage: "Opening took too long. Try again or download the original file.",
          },
          busy: { id: "preview.busy", defaultMessage: "Close another document preview, then try again." },
        }[reason.code]
      : {
          id: "office.failed",
          defaultMessage: "This document could not be displayed. You can download the original file.",
        };
  return (
    <div className="file-preview" data-file-preview-phase={document ? "ready" : error ? "failed" : "opening"}>
      <style data-file-preview-base children={previewBaseStyles} />
      {document?.styles ? <style data-file-preview-styles>{document.styles}</style> : null}
      <div ref={root} className="file-preview__document" hidden={!document} />
      {document?.render
        ? createPortal(
            document.render({
              active: props.active !== false,
              dark: props.dark,
              intl,
              download: props.download !== false,
            }),
            document.element,
          )
        : null}
      {!document ? (
        <div className="workspace-file-viewer__state" role="status">
          <span>
            {error
              ? intl.formatMessage(errorMessage)
              : intl.formatMessage({ id: "office.loading", defaultMessage: "Opening document…" })}
          </span>
          {error ? (
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              {intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
