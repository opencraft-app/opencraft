import { useContext, useEffect, useId, useMemo, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { PreviewSurface } from "@opencraft/design-system-web/preview-surface";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { CloseIcon, DownloadIcon } from "@opencraft/design-system-web/action-icons";
import { downloadBlob } from "@opencraft/design-system-web/download";
import { FilePreviewView, PreviewContext, usePrepareFilePreview, useFilePreviewDark } from "./index";
import type { FilePreviewDialogProps } from "./file-preview-dialog";
const styles = `
.opencraft-file-preview {width:min(1120px,calc(100vw - 24px));height:calc(100dvh - 24px);max-width:none;max-height:none;border:1px solid var(--color-border-subtle);border-radius:var(--radius-lg,12px);padding:0;color:var(--color-text);background:var(--color-background-surface)}
.opencraft-file-preview::backdrop{background:rgb(0 0 0 / 45%);backdrop-filter:blur(4px)}
.opencraft-file-preview__layout{height:100%;display:flex;min-height:0;flex-direction:column;overflow:hidden}
.opencraft-file-preview__header{display:flex;flex:none;gap:8px;align-items:center;padding:8px max(8px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));border-bottom:1px solid var(--color-border-subtle)}
.opencraft-file-preview__header h2{font:var(--typography-panelTitle-font,inherit);margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opencraft-file-preview__body{display:flex;flex:1;min-height:0;overflow:hidden}.opencraft-file-preview .file-preview,.opencraft-file-preview .file-preview__document{display:flex;flex:1;min-height:0;flex-direction:column;overflow:hidden}.opencraft-file-preview__state{margin:auto;padding:24px;text-align:center}
@media(max-width:639px){.opencraft-file-preview{inset:0;width:100vw;height:100dvh;margin:0;border:0;border-radius:0;padding-block:env(safe-area-inset-top) env(safe-area-inset-bottom);box-sizing:border-box}}
`;
export function FilePreviewDialogView({ resource, name, load, onClose, returnFocus }: FilePreviewDialogProps) {
  const intl = useIntl(),
    id = useId(),
    service = useContext(PreviewContext),
    prepare = usePrepareFilePreview(),
    dark = useFilePreviewDark();
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => ({}), [resource, load, attempt]);
  const [result, setResult] = useState<{ request: object; blob?: Blob; error?: boolean } | null>(null);
  useEffect(() => {
    const owner = new AbortController();
    const timeout = setTimeout(() => {
      setResult({ request, error: true });
      owner.abort();
    }, 45000);
    void load(owner.signal)
      .then(
        (blob) => {
          if (!owner.signal.aborted) setResult({ request, blob });
        },
        () => {
          if (!owner.signal.aborted) setResult({ request, error: true });
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      owner.abort();
    };
  }, [request, load]);
  useEffect(() => () => service?.releaseTab(id, id), [service, id]);
  const blob = result?.request === request ? result.blob : undefined;
  const error = result?.request === request && result.error;
  return (
    <PreviewSurface label={name} className="opencraft-file-preview" onClose={onClose} returnFocus={returnFocus}>
      {(close) => (
        <div className="opencraft-file-preview__layout">
          <style>{styles}</style>
          <header className="opencraft-file-preview__header">
            <h2>{name}</h2>
            {blob && (
              <IconButton
                aria-label={intl.formatMessage({ id: "pdf.download", defaultMessage: "Download file" })}
                onClick={() => downloadBlob(blob, name)}
              >
                <DownloadIcon />
              </IconButton>
            )}
            <IconButton
              aria-label={intl.formatMessage({ id: "common.close", defaultMessage: "Close" })}
              onClick={close}
            >
              <CloseIcon />
            </IconButton>
          </header>
          <div className="opencraft-file-preview__body">
            {blob ? (
              <FilePreviewView
                ownerId={id}
                tabId={id}
                resource={resource}
                blob={blob}
                name={name}
                download={false}
                dark={dark}
                prepare={prepare}
                onOpenLink={(url) => window.open(url, "_blank", "noopener,noreferrer")}
              />
            ) : (
              <div className="opencraft-file-preview__state" role="status">
                {intl.formatMessage(
                  error
                    ? {
                        id: "office.failed",
                        defaultMessage: "This document could not be displayed. You can download the original file.",
                      }
                    : { id: "office.loading", defaultMessage: "Opening document…" },
                )}
                {error && (
                  <Button onClick={() => setAttempt((n) => n + 1)}>
                    {intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </PreviewSurface>
  );
}
