import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import { Button } from "@opencraft/design-system-web/button";
import React, { createContext, useContext, useLayoutEffect, useEffect, useState, type ComponentType } from "react";

/** Optional framework readiness port. Leases describe mounted presentation only. */
export interface ViewPresentationReadiness { acquire(): () => void }
export const ViewPresentationReadinessContext = createContext<ViewPresentationReadiness | null>(null);

/** A registration is cheap; its presentation is loaded only by a mounted View.
 * Successful modules are shared, rejected attempts are retryable, and a retired
 * consumer cannot publish a late result. Business state stays with its owner.
 */
export function createDeferredView<Props extends object>(load: () => Promise<ComponentType<Props>>): ComponentType<Props> {
  let component: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;
  const acquire = () => {
    if (component) return Promise.resolve(component);
    if (!pending) pending = Promise.resolve().then(load).then(value => { component = value; return value; }).finally(() => { pending = null; });
    return pending;
  };
  return function DeferredView(props: Props) {
    const [Loaded, setLoaded] = useState<ComponentType<Props> | null>(() => component);
    const [attempt, retry] = useState(0);
    const [failed, setFailed] = useState(false);
    const readiness = useContext(ViewPresentationReadinessContext);
    useLayoutEffect(() => !Loaded && !failed ? readiness?.acquire() : undefined, [Loaded, failed, readiness]);
    useEffect(() => {
      if (Loaded) return;
      let active = true;
      setFailed(false);
      void acquire().then(value => { if (active) setLoaded(() => value); }, error => {
        // Let the application decide whether this is a stale deployment.
        window.dispatchEvent(new CustomEvent("opencraft:module-load-failed", { detail: error }));
        if (active) setFailed(true);
      });
      return () => { active = false; };
    }, [Loaded, attempt]);
    if (Loaded) return <Loaded {...props} />;
    return <div className="deferred-view" role="status" aria-live="polite" aria-label={failed ? undefined : "正在加载"}>
      {failed ? <Button type="button" className="ui-button" density="compact" variant="outline" onClick={() => retry(value => value + 1)}>重试</Button> : <span className="deferred-view__indicator" aria-hidden="true"><ProgressIndicator /></span>}
    </div>;
  };
}
