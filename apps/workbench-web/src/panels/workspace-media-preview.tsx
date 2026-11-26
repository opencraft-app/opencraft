import { useState } from "react";
import { DownloadIcon as Download } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { chatMediaMimeType } from "@opencraft/chat-render-react";

export { downloadBlob as downloadWorkspaceBlob } from "@opencraft/design-system-web/download";
import { downloadBlob as downloadWorkspaceBlob } from "@opencraft/design-system-web/download";
import { MediaPlayer } from "@opencraft/file-preview-web/media-player";

export function WorkspaceMediaPreview({ blob, name, kind }: { readonly blob: Blob; readonly name: string; readonly kind: "audio" | "video" | "file" }) {
  const intl = useIntl();
  const [failed, setFailed] = useState(false);
  return <div className="workspace-media-preview">
    {kind !== "file" ? <MediaPlayer blob={blob} type={chatMediaMimeType(name, "path")} kind={kind} label={name} onError={()=>setFailed(true)} /> : null}
    {kind === "file" || failed ? <p>{intl.formatMessage({ id: "media.unavailable", defaultMessage: "Preview unavailable. Download this file to open it." })}</p> : null}
    <button type="button" onClick={() => downloadWorkspaceBlob(blob, name)}><Download size={16} />{intl.formatMessage({ id: "pdf.download", defaultMessage: "Download file" })}</button>
  </div>;
}
