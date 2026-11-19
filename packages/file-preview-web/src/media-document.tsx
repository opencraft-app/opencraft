import { useState } from "react";
import type { FilePreviewIntl } from "./index";
import { MediaPlayer } from "./media-player";
import { downloadBlob } from "@opencraft/design-system-web/download";
import type { WebPreviewDocument } from "./index";
const styles =
  ".file-media-preview{display:flex;flex:1;min-height:0;height:100%;flex-direction:column;gap:12px;padding:12px;box-sizing:border-box}.file-media-preview video{width:100%;min-height:0;flex:1;object-fit:contain}.file-media-preview audio{width:100%}.file-media-preview button{align-self:center}";
export function openMedia({ blob, name }: { blob: Blob; name: string }): WebPreviewDocument {
  const element = document.createElement("div");
  element.style.height = "100%";
  const kind = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/iu.test(name) ? "video" : "audio";
  return {
    element,
    render: ({ active, intl, download }) => (
      <MediaDocumentView blob={blob} name={name} kind={kind} active={active} intl={intl} download={download} />
    ),
    setActive(active) {
      if (!active) element.querySelectorAll("audio,video").forEach((node) => (node as HTMLMediaElement).pause());
    },
    dispose() {
      element.querySelectorAll("audio,video").forEach((node) => {
        const player = node as HTMLMediaElement;
        player.pause();
        player.removeAttribute("src");
        player.load();
      });
      element.remove();
    },
  };
}

function MediaDocumentView({
  blob,
  name,
  kind,
  active,
  intl,
  download,
}: {
  blob: Blob;
  name: string;
  kind: "audio" | "video";
  active: boolean;
  intl: FilePreviewIntl;
  download: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="file-media-preview">
      <style>{styles}</style>
      <MediaPlayer blob={blob} kind={kind} label={name} active={active} onError={() => setFailed(true)} />
      {failed && (
        <p role="status">
          {intl.formatMessage({
            id: "media.unavailable",
            defaultMessage: "Preview unavailable. Download this file to open it.",
          })}
        </p>
      )}
      {download && (
        <button type="button" onClick={() => downloadBlob(blob, name)}>
          {intl.formatMessage({ id: "pdf.download", defaultMessage: "Download file" })}
        </button>
      )}
    </div>
  );
}
