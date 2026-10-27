import { Button } from "@opencraft/design-system-web/button";
import React, { useEffect, useState, type ComponentType } from "react";

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
    useEffect(() => {
      if (Loaded) return;
      let active = true;
      setFailed(false);
      void acquire().then(value => { if (active) setLoaded(() => value); }, () => { if (active) setFailed(true); });
      return () => { active = false; };
    }, [Loaded, attempt]);
    if (Loaded) return <Loaded {...props} />;
    return <div className="deferred-view" role="status" aria-live="polite">
      {failed ? <Button type="button" className="ui-button" density="compact" variant="outline" onClick={() => retry(value => value + 1)}>重试</Button> : <span>正在加载…</span>}
    </div>;
  };
}
