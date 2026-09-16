import { AgentState, agentButtonClassName } from "@/components/agents";
import { Button } from "@/components/ui/button";

type AgentChatStatusViewProps = {
  kind: "loading";
  title: string;
} | {
  kind: "error";
  title: string;
  retryLabel: string;
  onRetry: () => void;
};

/** Host-only status presentation. The SDK, token cache and retry ownership stay in the caller. */
export function AgentChatStatusView(props: AgentChatStatusViewProps) {
  return (
    <div className="flex h-full min-w-0 items-center justify-center p-4 sm:p-6">
      <AgentState
        kind={props.kind}
        title={props.title}
        className="w-full max-w-lg break-words"
        action={props.kind === "error" ? <Button type="button" variant="outline" className={agentButtonClassName} onClick={props.onRetry}>{props.retryLabel}</Button> : undefined}
      />
    </div>
  );
}
