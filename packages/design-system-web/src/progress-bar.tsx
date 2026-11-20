import { ProgressIndicatorBase } from './progress-base';
import '@opencraft/design-system/progress-bar.web';

/** Demand-loaded bar presentation; motion and accessibility share the ring owner. */
export function ProgressBar(props: { readonly className?: string; readonly value?: number }) {
  return <ProgressIndicatorBase {...props} variant="bar" />;
}
