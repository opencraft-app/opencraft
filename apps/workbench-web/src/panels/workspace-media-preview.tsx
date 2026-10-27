import { useEffect, useState } from "react";
import { DownloadIcon as Download } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { chatMediaMimeType } from "@opencraft/chat-render-react";

export function downloadWorkspaceBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  // Keep the URL until the browser has consumed the download navigation.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkspaceMediaPreview({ blob, name, kind }: { readonly blob: Blob; readonly name: string; readonly kind: "audio" | "video" | "file" }) {
  const intl = useIntl();
  const [source, setSource] = useState<{ blob: Blob; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (kind === "file") { setSource(null); return; }
    const url = URL.createObjectURL(blob.slice(0, blob.size, chatMediaMimeType(name)));
    setSource({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob, kind, name]);
  return <div className="workspace-media-preview">
    {source?.blob === blob && kind === "video" ? <video key={source.url} src={source.url} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} /> : null}
    {source?.blob === blob && kind === "audio" ? <audio key={source.url} src={source.url} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} /> : null}
    {kind === "file" || failed ? <p>{intl.formatMessage({ id: "media.unavailable", defaultMessage: "Preview unavailable. Download this file to open it." })}</p> : null}
    <button type="button" onClick={() => downloadWorkspaceBlob(blob, name)}><Download size={16} />{intl.formatMessage({ id: "pdf.download", defaultMessage: "Download file" })}</button>
  </div>;
}
