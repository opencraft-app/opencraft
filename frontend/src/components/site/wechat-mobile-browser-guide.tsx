import { useId, useState } from "react";

import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";

const wechatLogo = assetUrl("/login/wechat-logo.png");

type CopyState = "idle" | "success" | "error";

interface WeChatMobileBrowserGuideProps {
  beforeCopy?: () => boolean;
  className?: string;
  loginUrl: string;
}

export function WeChatMobileBrowserGuide({
  beforeCopy,
  className,
  loginUrl,
}: WeChatMobileBrowserGuideProps) {
  const t = useT();
  const promptId = useId();
  const statusId = useId();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const handleCopy = async () => {
    if (beforeCopy && !beforeCopy()) {
      setCopyState("idle");
      return;
    }

    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(loginUrl);
      setCopyState("success");
    } catch {
      setCopyState("error");
    }
  };

  const statusMessage =
    copyState === "success"
      ? t("已复制，请打开微信粘贴访问")
      : copyState === "error"
        ? t("复制失败，请重试")
        : null;

  return (
    <div className={cn("flex w-full flex-col items-center", className)}>
      <img
        src={wechatLogo}
        alt=""
        aria-hidden="true"
        className="size-16 select-none object-contain pointer-events-none"
      />
      <p
        id={promptId}
        className="mt-4 text-center text-sm font-medium text-pretty text-slate-900"
      >
        {t("复制链接，前往「微信」打开")}
      </p>
      <button
        type="button"
        autoFocus
        onClick={() => void handleCopy()}
        aria-describedby={statusMessage ? `${promptId} ${statusId}` : promptId}
        className="mt-6 flex w-full items-center justify-center rounded-full border border-black bg-black px-8 py-[10px] text-sm font-medium text-white transition-all duration-200 hover:bg-slate-800 hover:shadow-sm active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
      >
        {t("复制链接")}
      </button>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn(
          "mt-2 min-h-5 text-center text-xs font-medium",
          copyState === "success" ? "text-emerald-700" : "text-[var(--danger)]",
        )}
      >
        {statusMessage}
      </p>
    </div>
  );
}
