import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─── Step Definitions ─── */

export const SETUP_STEPS = [
  { label: "开通并配置", key: "create" },
  { label: "绑定套餐", key: "subscribe" },
  { label: "接入通道", key: "channel" },
  { label: "配置技能", key: "persona" },
] as const;

export type SetupStepKey = (typeof SETUP_STEPS)[number]["key"];

/* ─── Component ─── */

interface SetupStepTimelineProps {
  /** The key of the currently active step */
  currentStep: SetupStepKey;
  className?: string;
}

export const SetupStepTimeline = ({ currentStep, className }: SetupStepTimelineProps) => {
  const currentIndex = SETUP_STEPS.findIndex((s) => s.key === currentStep);

  return (
    <div className={cn("mx-auto flex max-w-xl items-center justify-center px-4", className)}>
      {SETUP_STEPS.map((step, idx) => {
        const isCompleted = idx < currentIndex;
        const isCurrent = idx === currentIndex;
        const isFuture = idx > currentIndex;

        return (
          <div key={step.key} className="flex items-center">
            {/* Step Node */}
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold transition-all duration-300",
                  isCompleted && "text-white",
                  isCurrent && "text-white",
                  isFuture && "border-[1.5px] text-[#999]",
                )}
                style={{
                  ...(isCompleted ? {
                    background: "var(--lw-accent)",
                    boxShadow: "0 4px 12px rgba(247,102,91,0.25)",
                  } : {}),
                  ...(isCurrent ? {
                    background: "linear-gradient(135deg, var(--lw-accent), #ff8c42)",
                    boxShadow: "0 4px 16px rgba(247,102,91,0.3)",
                  } : {}),
                  ...(isFuture ? {
                    borderColor: "#ddd",
                    background: "#fff",
                  } : {}),
                }}
              >
                {isCompleted ? <Check className="h-4 w-4" /> : idx + 1}
              </div>
              <span
                className={cn(
                  "mt-2 whitespace-nowrap text-center text-[11px] font-medium transition-colors",
                  isCompleted && "font-semibold",
                  isCurrent && "font-bold",
                )}
                style={{
                  color: isCompleted ? "var(--lw-accent)" : isCurrent ? "var(--lw-fg)" : "#999",
                }}
              >
                {step.label}
              </span>
            </div>

            {/* Connector Line */}
            {idx < SETUP_STEPS.length - 1 && (
              <div
                className="mx-3 h-[2px] w-12 rounded-full transition-all duration-500 sm:mx-4 sm:w-16"
                style={{
                  background: idx < currentIndex
                    ? "linear-gradient(90deg, var(--lw-accent), rgba(247,102,91,0.5))"
                    : "#eee",
                  marginBottom: "1.5rem",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
