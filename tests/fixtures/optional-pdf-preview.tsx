import { useState } from 'react';
import { WorkspacePdfPreviewLoader } from '../../apps/workbench-web/src/panels/workspace-pdf-preview-loader';
import { createIntlTestRoot } from './intl-root';

function Fixture() {
  const [pdf, setPdf] = useState<Blob | null>(null);
  return <>
    <h1>Core 中文 workspace</h1>
    <button onClick={() => void fetch('/fixture.pdf').then(response => response.blob()).then(setPdf)}>Open PDF</button>
    <div style={{ height: 600 }}>{pdf ? <WorkspacePdfPreviewLoader blob={pdf} name="fixture.pdf" /> : null}</div>
  </>;
}
createIntlTestRoot(document.getElementById('host')!).render(<Fixture />);
