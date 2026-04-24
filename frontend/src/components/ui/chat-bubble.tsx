import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ChatBubbleTone = "assistant" | "user" | "system";

interface ChatBubbleProps extends HTMLAttributes<HTMLDivElement> {
  tone?: ChatBubbleTone;
}

const toneClasses: Record<ChatBubbleTone, string> = {
  assistant:
    "max-w-[90%] rounded-[1.35rem] border border-[var(--border-subtle)] bg-white text-[var(--text-secondary)] shadow-[0_16px_34px_-28px_rgba(15,23,42,0.28)]",
  user: "ml-auto max-w-[85%] rounded-[1.35rem] bg-[var(--brand-600)] text-white shadow-[0_20px_38px_-28px_rgba(35,71,200,0.72)]",
  system:
    "max-w-[92%] rounded-[1.35rem] border border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--surface-muted)_70%,white)] text-[var(--text-secondary)]",
};

export const ChatBubble = ({ tone = "assistant", className, ...props }: ChatBubbleProps) => (
  <div className={cn("p-3 text-sm leading-7", toneClasses[tone], className)} {...props} />
);
