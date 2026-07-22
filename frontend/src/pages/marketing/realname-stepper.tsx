import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type RealnameStage = "identity" | "face" | "phone" | "shadow";

interface RealnameStepperProps {
  stage: RealnameStage;
  includePhoneStep: boolean;
  labels: {
    identity: string;
    face: string;
    phone: string;
  };
}

export const RealnameStepper = ({
  stage,
  includePhoneStep,
  labels,
}: RealnameStepperProps) => {
  const steps: Array<Exclude<RealnameStage, "shadow">> = includePhoneStep
    ? ["identity", "face", "phone"]
    : ["identity", "face"];
  const currentIndex = stage === "shadow" ? steps.length : steps.indexOf(stage);

  return (
    <ol className="flex w-full items-center" aria-label="实名认证进度">
      {steps.map((step, index) => {
        const state = index < currentIndex
          ? "complete"
          : index === currentIndex
            ? "current"
            : "upcoming";

        return (
          <li
            key={step}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center",
              index < steps.length - 1 && "flex-1",
            )}
          >
            <span className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-150",
                  state === "upcoming"
                    ? "bg-black/[0.06] text-black/35"
                    : "bg-[#202020] text-white",
                )}
                aria-hidden="true"
              >
                {state === "complete" ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-[13px]",
                  state === "current"
                    ? "font-medium text-black/90"
                    : state === "complete"
                      ? "text-black/55"
                      : "text-black/35",
                )}
              >
                {labels[step]}
              </span>
            </span>
            {index < steps.length - 1 && (
              <span
                className={cn(
                  "mx-3 h-px min-w-4 flex-1 transition-colors duration-150",
                  index < currentIndex ? "bg-[#202020]" : "bg-black/10",
                )}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
};
