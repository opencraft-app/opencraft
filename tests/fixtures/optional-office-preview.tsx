import { Context } from '@deepseek-ai/cordis';
import { useState } from 'react';
import { FilePreviewService, FilePreviewProvider, FilePreviewView } from '@opencraft/file-preview-web';
import { OfficePreviewPlugin } from '@opencraft/plugin-office-preview';
import { preparePreviewResources } from '../../apps/workbench-web/src/panels/prepare-preview-resources';
import { createIntlTestRoot } from './intl-root';
const context = new Context();
await context.plugin(FilePreviewService);
await context.plugin(OfficePreviewPlugin);
(window as any).previewService=context.filePreviews;
function Fixture() {
 const [file,setFile]=useState<{name:string;blob:Blob}|null>(null);
 return <FilePreviewProvider service={context.filePreviews}>
  <h1>Core 中文 workspace</h1>
  {['docx','pptx','xlsx'].map(kind=><button key={kind} onClick={()=>void fetch('/sample.'+kind).then(r=>r.blob()).then(blob=>setFile({name:'sample.'+kind,blob}))}>Open {kind.toUpperCase()}</button>)}
  <div style={{height:600,display:'flex'}}>{file?<FilePreviewView ownerId="fixture" tabId={file.name} resource={file.name} name={file.name} blob={file.blob} dark={false} prepare={preparePreviewResources}/>:null}</div>
 </FilePreviewProvider>;
}
createIntlTestRoot(document.getElementById('host')!).render(<Fixture/>);
