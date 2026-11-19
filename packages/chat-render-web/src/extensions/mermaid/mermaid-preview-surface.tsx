import { PreviewSurface, type PreviewSurfaceProps } from '@opencraft/design-system-web/preview-surface';
import styles from './mermaid-preview.scss?inline';
/** Preview-only chrome and its isolated stylesheet follow the expand gesture. */
export default function MermaidPreviewSurface(props:Omit<PreviewSurfaceProps,'styles'>){
  return <PreviewSurface {...props} styles={styles}/>;
}
