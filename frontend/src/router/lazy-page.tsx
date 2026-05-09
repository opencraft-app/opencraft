import { Suspense, lazy, type ComponentType, type ReactElement } from "react";

import { t } from "@/i18n/t";

function RouteFallback() {
  return (
    <div
      className="relative grid min-h-[42vh] place-items-center overflow-hidden px-6 py-16"
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-none absolute left-1/2 top-8 h-44 w-44 -translate-x-1/2 rounded-full bg-[rgba(40,93,255,0.10)] blur-3xl motion-safe:animate-pulse" />
      <div className="pointer-events-none absolute bottom-8 right-1/2 h-28 w-28 translate-x-24 rounded-full bg-[rgba(255,210,155,0.22)] blur-3xl" />

      <div className="relative flex w-full max-w-sm flex-col items-center text-center">
        <div className="mb-5 flex items-center gap-2 rounded-full border border-[rgba(26,26,26,0.08)] bg-[rgba(255,255,255,0.88)] px-3 py-1.5 shadow-[0_18px_55px_rgba(30,24,18,0.08)] backdrop-blur">
          <span className="h-2 w-2 rounded-full bg-[var(--lw-accent)] shadow-[0_0_18px_rgba(40,93,255,0.72)] motion-safe:animate-pulse" />
          <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-[rgba(26,26,26,0.56)]">
            LightVela
          </span>
        </div>

        <div className="h-1 w-48 overflow-hidden rounded-full bg-[rgba(26,26,26,0.08)]">
          <div className="h-full w-1/2 rounded-full bg-[linear-gradient(90deg,transparent,var(--lw-accent),transparent)] motion-safe:animate-[route-load_1.35s_ease-in-out_infinite]" />
        </div>

        <p className="mt-5 text-sm font-medium text-[var(--lw-fg)]">
          {t("正在准备下一页")}
        </p>
        <p className="mt-2 text-xs leading-5 text-[rgba(26,26,26,0.52)]">
          {t("云端伙伴马上就绪。")}
        </p>
      </div>

      <style>{`
        @keyframes route-load {
          0% { transform: translateX(-115%); }
          100% { transform: translateX(215%); }
        }
      `}</style>
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
