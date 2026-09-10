import type { ReactNode } from "react";

/**
 * Owns the presentation boundary required by the mechanically vendored mono2
 * Agent Console panels.
 *
 * Radix renders selects, popovers and dialogs below <body>, outside this
 * subtree. Those portal roots carry their own explicit presentation boundary;
 * this host therefore has no body or route lifecycle side effects.
 */
export function HermesAgentConsoleHost({
  children,
  className = "",
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={`lightvela-agent-console _lh-claw-bot-panel ${className}`.trim()}>
      {children}
    </div>
  );
}
