import { Suspense, lazy, type ComponentType, type ReactElement } from "react";

function RouteFallback() {
  return null;
}

export function lazyNamed<T extends string>(
  loader: () => Promise<Record<T, ComponentType>>,
  exportName: T,
) {
  return lazy(async () => {
    const module = await loader();
    return { default: module[exportName] };
  });
}

export function lazyRoute(Component: ComponentType): ReactElement {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Component />
    </Suspense>
  );
}
