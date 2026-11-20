import { useContext, useEffect, useId } from "react";
import { FilePreviewView, PreviewContext } from "@opencraft/file-preview-web";
import { preparePreviewResources } from "./prepare-preview-resources";
export function WorkspacePdfPreview({blob,name}:{blob:Blob;name:string}) {
  const id=useId(), service=useContext(PreviewContext);
  useEffect(()=>()=>service?.releaseTab("pdf-preview",id),[service,id]);
  return <FilePreviewView ownerId="pdf-preview" tabId={id} resource={name} blob={blob} name={name} dark={false} prepare={preparePreviewResources} />;
}
