import { Sparkles } from "lucide-react";

import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { DEFAULT_AVATAR_COLOR, GeometricAvatar } from "@/pages/marketing/agent-avatar-shapes";

/** Domestic Chat loading state; callers keep the global site on its original prompts. */
export function ChatLoadingState({ className }: { className?: string }) {
  const t = useT();

  return (
    <div
      className={cn("flex min-w-0 flex-col items-center justify-center gap-3 px-4 py-6 text-center", className)}
      role="status"
      aria-live="polite"
    >
      <div className="relative flex size-24 shrink-0 items-center justify-center rounded-full bg-orange-50" aria-hidden="true">
        <GeometricAvatar shapeId="blob" color={DEFAULT_AVATAR_COLOR} size={72} alive />
        <Sparkles className="absolute right-0 top-1 size-4 text-orange-400 motion-safe:animate-pulse" />
      </div>
      <div className="w-full max-w-xs space-y-1">
        <p className="text-pretty text-base font-medium leading-6 text-black/80">
          {t("你的 AI 伙伴，马上就来")}
          <span className="ml-0.5 inline-flex text-black/55" aria-hidden="true">
            <span className="lv-chat-loading-dot">.</span>
            <span className="lv-chat-loading-dot">.</span>
            <span className="lv-chat-loading-dot">.</span>
          </span>
        </p>
      </div>
    </div>
  );
}
