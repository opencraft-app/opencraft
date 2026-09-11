// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { Loader2 } from "lucide-react";
import { cn } from "../../../lib/utils";

export const MODEL_CONTROL_CLASS = "lv-model-control h-12";
export const MODEL_SELECT_CONTENT_CLASS = "lv-model-select-content max-h-80 w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]";

export function modelCompoundClasses(isGlobalRegion: boolean) {
  return {
    control: cn("min-w-0 overflow-hidden rounded-md border border-black/10 bg-white shadow-none transition-colors focus-within:border-[#2F6BFF]", isGlobalRegion
      ? "grid h-auto grid-cols-1 sm:h-12 sm:grid-cols-[minmax(0,1fr)_max-content]" : "flex h-12"),
    field: cn("min-w-0 rounded-none border-0 bg-transparent shadow-none outline-none focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0", isGlobalRegion ? "h-12 w-full sm:h-full" : "h-full flex-1"),
    action: cn("shrink-0 whitespace-nowrap rounded-none border-0 bg-white px-3 shadow-none hover:translate-y-0 hover:border-black/10 hover:bg-black/[0.025] focus-visible:ring-inset", isGlobalRegion
      ? "h-12 w-full border-t border-black/10 sm:h-full sm:w-auto sm:min-w-max sm:border-l sm:border-t-0 sm:px-4" : "h-full min-w-max border-l border-black/10 px-4"),
  };
}

export function ModelCompoundActionContent({ idleLabel, loadingLabel, loading }: {
  idleLabel: string;
  loadingLabel: string;
  loading: boolean;
}) {
  return (
    <span className="relative grid place-items-center">
      <span aria-hidden="true" data-slot="model-compound-action-width-label" className="invisible whitespace-nowrap">{idleLabel}</span>
      <span className="absolute inset-0 inline-flex items-center justify-center gap-2 whitespace-nowrap">
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
        {loading ? loadingLabel : idleLabel}
      </span>
    </span>
  );
}
