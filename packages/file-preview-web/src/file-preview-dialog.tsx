import { PendingPreview } from "@opencraft/design-system-web/preview-activation";
import { lazy, Suspense, useEffect } from "react";
export interface FilePreviewDialogProps {
  readonly resource: string;
  readonly name: string;
  readonly load: (signal:AbortSignal)=>Promise<Blob>;
  readonly onClose: ()=>void;
  readonly returnFocus?: ()=>HTMLElement|null;
}
const View = lazy(()=>import("./file-preview-dialog-view").then(module=>({default:module.FilePreviewDialogView})));
export function FilePreviewDialog(props:FilePreviewDialogProps) { return <Suspense fallback={<PendingPreview onClose={props.onClose} />}><View {...props} /></Suspense>; }
