import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import { Button } from "@opencraft/design-system-web/button";
import React, { useContext, useEffect, useState, type ComponentType } from "react";
import { IntlContext } from "react-intl";

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
    const intl = useContext(IntlContext);
    const loadingLabel = intl?.formatMessage({ id: "chat.composer.loading", defaultMessage: "Loading…" }) ?? "Loading…";
    const retryLabel = intl?.formatMessage({ id: "common.retry", defaultMessage: "Try again" }) ?? "Try again";
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
    return <div className="deferred-view" role="status" aria-live="polite" aria-label={failed ? undefined : loadingLabel}>
      {failed ? <Button type="button" className="ui-button" density="compact" variant="outline" onClick={() => retry(value => value + 1)}>{retryLabel}</Button> : <span className="deferred-view__indicator" aria-hidden="true"><ProgressIndicator /></span>}
    </div>;
  };
}
