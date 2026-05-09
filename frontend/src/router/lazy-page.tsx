import { Suspense, lazy, type ComponentType, type ReactElement } from "react";

function RouteFallback() {
  return (
    <div className="flex min-h-[42vh] items-center justify-center px-6 py-16 text-sm text-[var(--text-secondary)]">
      页面加载中...
    </div>
  );
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
