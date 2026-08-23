import { useId, useState } from "react";

import {
  AUTH_DIALOG_PENDING_BUTTON_CLASS,
  AUTH_DIALOG_PRIMARY_BUTTON_CLASS,
} from "@/components/site/auth-dialog-styles";
import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";

const wechatLogo = assetUrl("/login/wechat-logo.png");

type CopyState = "idle" | "success" | "error";

interface WeChatMobileBrowserGuideProps {
  autoFocus?: boolean;
  beforeCopy?: () => boolean;
  blocked?: boolean;
  className?: string;
  loginUrl: string;
  onCopySuccess?: () => void;
}

const copyWithExecCommand = (text: string) => {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
};

export function WeChatMobileBrowserGuide({
  autoFocus = false,
  beforeCopy,
  blocked = false,
  className,
  loginUrl,
  onCopySuccess,
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

    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(loginUrl);
        copied = true;
      } catch {
        copied = copyWithExecCommand(loginUrl);
      }
    } else {
      copied = copyWithExecCommand(loginUrl);
    }

    if (copied) {
      setCopyState("success");
      onCopySuccess?.();
      return;
    }

    setCopyState("error");
  };

  const statusMessage =
    copyState === "success"
      ? t("已复制，请打开微信粘贴访问")
      : copyState === "error"
        ? t("复制失败，请长按复制下方链接")
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
        autoFocus={autoFocus}
        onClick={() => void handleCopy()}
        aria-disabled={blocked}
        aria-describedby={statusMessage ? `${promptId} ${statusId}` : promptId}
        className={cn(
          AUTH_DIALOG_PRIMARY_BUTTON_CLASS,
          "mt-6 border-black bg-black text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2",
          blocked && AUTH_DIALOG_PENDING_BUTTON_CLASS,
        )}
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
      {copyState === "error" ? (
        <textarea
          aria-label={t("微信登录链接")}
          readOnly
          rows={3}
          value={loginUrl}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-2 w-full resize-none rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
        />
      ) : null}
    </div>
  );
}
