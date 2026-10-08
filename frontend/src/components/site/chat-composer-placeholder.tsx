import { ArrowUp } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";

import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";

/**
 * New-conversation composer shown while the embedded Workbench connects.
 * The host owns the text; a queued message is handed to the real Composer once it is ready.
 */
export function ChatComposerPlaceholder({
  className,
  value,
  queued,
  rejected,
  connecting,
  onChange,
  onSubmit,
}: {
  className?: string;
  value: string;
  queued: boolean;
  rejected: boolean;
  connecting: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const canSubmit = !queued && value.trim() !== "";
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSubmit) onSubmit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className={cn("flex w-full min-w-0 flex-col items-center gap-6 px-4 py-6", className)}>
      <h2 className="text-pretty text-center text-2xl font-normal leading-8 text-black/85">
        {t("今天想一起做点什么？")}
      </h2>
      <form
        onSubmit={submit}
        className="w-full max-w-2xl rounded-xl border border-black/[0.08] bg-white p-3 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
      >
        <textarea
          autoFocus
          aria-label={t("聊聊你的想法，或交给我一件事")}
          className="block h-16 w-full resize-none bg-transparent text-sm leading-6 text-black/85 outline-none placeholder:text-black/35 read-only:text-black/50"
          placeholder={t("聊聊你的想法，或交给我一件事")}
          readOnly={queued}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="min-w-0 text-xs text-black/45" role="status" aria-live="polite">
            {queued ? t("连上后自动发送…") : rejected ? t("未能发送，请重试") : connecting ? t("正在连接…") : null}
          </p>
          <button
            type="submit"
            aria-label={t("发送")}
            disabled={!canSubmit}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-black/85 text-white transition-colors hover:bg-black disabled:bg-black/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
}
