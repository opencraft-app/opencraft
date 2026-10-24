import { LoadingRingIcon as LoaderCircle } from "@opencraft/design-system-web/action-icons";
import { preparePreviewResources } from "./prepare-preview-resources";
import { useEffect, useState } from "react";

import { useIntl } from "@opencraft/i18n/react";

type PdfPreview = typeof import("./workspace-pdf-preview")["WorkspacePdfPreview"];

export function WorkspacePdfPreviewLoader(props: { readonly blob: Blob; readonly name: string }) {
  const intl = useIntl();
  const [Preview, setPreview] = useState<PdfPreview | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void (async () => {
      await preparePreviewResources();
      const module = await import("./workspace-pdf-preview");
      if (active) setPreview(() => module.WorkspacePdfPreview);
    })().catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  if (Preview) return <Preview {...props} />;
  return <div className="workspace-file-viewer__state" role="status">
    {failed ? <>
      <span>{intl.formatMessage({ id: "pdf.failed", defaultMessage: "This PDF could not be displayed. Download it to open in another reader." })}</span>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>{intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}</button>
    </> : <><LoaderCircle className="is-spinning" size={18} />{intl.formatMessage({ id: "pdf.loading", defaultMessage: "Loading PDF…" })}</>}
  </div>;
}
