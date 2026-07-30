import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const REALNAME_STAGE_ORDER = ["identity", "face", "phone"] as const;
const REALNAME_SHADOW_STAGE = "shadow" as const;
const STEPPER_STATE = {
  COMPLETE: "complete",
  CURRENT: "current",
  UPCOMING: "upcoming",
} as const;

type RealnameCoreStage = (typeof REALNAME_STAGE_ORDER)[number];
export type RealnameStage = RealnameCoreStage | typeof REALNAME_SHADOW_STAGE;

interface RealnameStepperProps {
  stage: RealnameStage;
  includeFaceStep?: boolean;
  includePhoneStep: boolean;
  labels: Record<RealnameCoreStage, string>;
}

export const RealnameStepper = ({
  stage,
  includeFaceStep = true,
  includePhoneStep,
  labels,
}: RealnameStepperProps) => {
  const steps: readonly RealnameCoreStage[] = REALNAME_STAGE_ORDER.filter((step) => (
    (includeFaceStep || step !== "face") && (includePhoneStep || step !== "phone")
  ));
  const currentIndex = stage === REALNAME_SHADOW_STAGE ? steps.length : steps.indexOf(stage);

  return (
    <ol className="flex w-full items-center" aria-label="实名认证进度">
      {steps.map((step, index) => {
        const state = index < currentIndex
          ? STEPPER_STATE.COMPLETE
          : index === currentIndex
            ? STEPPER_STATE.CURRENT
            : STEPPER_STATE.UPCOMING;

        return (
          <li
            key={step}
            data-state={state}
            aria-current={state === STEPPER_STATE.CURRENT ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center",
              index < steps.length - 1 && "flex-1",
            )}
          >
            <span className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-150",
                  state === STEPPER_STATE.UPCOMING
                    ? "bg-[var(--surface-muted)] text-[var(--text-tertiary)]"
                    : "bg-[var(--text-primary)] text-[var(--surface-base)]",
                )}
                aria-hidden="true"
              >
                {state === STEPPER_STATE.COMPLETE ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-[13px]",
                  state === STEPPER_STATE.CURRENT
                    ? "font-medium text-[var(--text-primary)]"
                    : state === STEPPER_STATE.COMPLETE
                      ? "text-[var(--text-secondary)]"
                      : "text-[var(--text-tertiary)]",
                )}
              >
                {labels[step]}
              </span>
            </span>
            {index < steps.length - 1 && (
              <span
                className={cn(
                  "mx-3 h-px min-w-4 flex-1 transition-colors duration-150",
                  index < currentIndex ? "bg-[var(--text-primary)]" : "bg-[var(--border-strong)]",
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
