import { Bot, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const TONES = ["#CDC5F0", "#F6C9C7", "#FCE0B5", "#CDE5E5", "#BED2F8"];
const toneFor = (seed: string) => TONES[[...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % TONES.length];

interface VelaImAvatarProps {
  name: string;
  seed?: string;
  kind?: "human" | "agent" | "group";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE = { sm: "size-7 text-[11px]", md: "size-9 text-sm", lg: "size-11 text-base" };
const ICON = { sm: "size-3.5", md: "size-4", lg: "size-5" };

export function VelaImAvatar({ name, seed, kind = "human", size = "md", className }: VelaImAvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-black/70", SIZE[size], className)}
      style={{ background: toneFor(seed ?? name) }}
    >
      {kind === "agent" ? <Bot className={ICON[size]} /> : kind === "group" ? <Users className={ICON[size]} /> : (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
