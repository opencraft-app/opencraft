import { FileCode2, FileImage, FileJson2, FileText } from "lucide-react";

import { workspaceFileKind } from "./workspace-resource-model";

export function WorkspaceFileIcon({ path, size }: { readonly path: string; readonly size: number }) {
  const kind = workspaceFileKind(path);
  if (kind === "image") return <FileImage size={size} />;
  if (kind === "json") return <FileJson2 size={size} />;
  if (kind === "text") return <FileText size={size} />;
  if (kind === "css" || kind === "javascript" || kind === "typescript") {
    return <span aria-hidden="true" className={`workspace-file-icon workspace-file-icon--${kind}`} style={{ width: size, height: size }}>{kind === "css" ? "CSS" : kind === "javascript" ? "JS" : "TS"}</span>;
  }
  return <FileCode2 size={size} />;
}
