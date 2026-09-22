// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useId } from "react";
import { CheckCircle2, Loader2, X, Zap } from "lucide-react";
import { AgentTooltip } from "../../components/agents/index";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

/** Presentation only. Cancel stays available while the host is submitting. */
export function AutomationFormActionsView({ fixedHeight, canTestRun, testRunDisabledReason, testState, canSubmit, submitDisabledReason, submitting, labels, onTestRun, onClose, onSubmit }: {
  fixedHeight: boolean;
  canTestRun: boolean;
  testRunDisabledReason: string | null;
  testState: "idle" | "running" | "ok" | "fail";
  canSubmit: boolean;
  submitDisabledReason: string | null;
  submitting: boolean;
  labels: { test: string; cancel: string; submit: string };
  onTestRun: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const hintId = useId();
  const submitButton = <Button size="sm" className="h-9 min-w-[72px] rounded-md text-sm" disabled={!canSubmit} onClick={onSubmit}>{submitting && <Loader2 className="size-3.5 animate-spin" />}{labels.submit}</Button>;
  return <div data-slot="automation-form-actions" className={cn("flex flex-wrap items-center justify-end gap-2", fixedHeight ? "mt-auto pt-4" : "mt-4")}>
    <AgentTooltip content={testRunDisabledReason ?? undefined} triggerMode={testRunDisabledReason ? "explanation" : "control"}>
      <Button variant="outline" size="sm" className="h-9 min-w-[104px] rounded-md text-sm" disabled={!canTestRun} onClick={onTestRun} aria-describedby={testRunDisabledReason ? hintId : undefined}>
        {testState === "running" ? <Loader2 className="size-3.5 animate-spin" /> : testState === "ok" ? <CheckCircle2 className="size-3.5 text-[#0F8A4B]" /> : testState === "fail" ? <X className="size-3.5 text-[#B91C1C]" /> : <Zap className="size-3.5" />}
        {labels.test}
      </Button>
    </AgentTooltip>
    {testRunDisabledReason && <span id={hintId} className="sr-only">{testRunDisabledReason}</span>}
    <Button variant="outline" size="sm" className="h-9 rounded-md text-sm" onClick={onClose}>{labels.cancel}</Button>
    {submitDisabledReason ? <AgentTooltip content={submitDisabledReason}>{submitButton}</AgentTooltip> : submitButton}
  </div>;
}
