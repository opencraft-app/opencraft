"use client";

import type { RequestDockRenderModel } from "../../../../vela-chat-render-model/src";
import styles from "../../styles/desktop.module.css";

export interface RequestDockResponse {
  requestId: string;
  result: "allow" | "deny";
}

export interface RequestDockProps {
  requests: RequestDockRenderModel;
  isResponding?: boolean;
  onRespondToRequest?: (response: RequestDockResponse) => void;
}

export function RequestDock({
  requests,
  isResponding = false,
  onRespondToRequest,
}: RequestDockProps) {
  const pending = requests.items.filter((request) => request.status === "pending");
  if (!pending.length) return null;

  return (
    <section className={styles.requestDock} aria-label="Pending requests">
      {pending.map((request) => (
        <article className={styles.requestCard} key={request.id}>
          <div className={styles.requestContent}>
            <span className={styles.requestKicker}>{requestLabel(request.type)}</span>
            <strong className={styles.requestTitle}>{request.title}</strong>
            {request.description ? (
              <span className={styles.requestDescription}>{request.description}</span>
            ) : null}
          </div>
          {request.confirmable && onRespondToRequest ? (
            <div className={styles.requestActions}>
              <button
                className={styles.requestSecondaryButton}
                disabled={isResponding}
                type="button"
                onClick={() => onRespondToRequest({ requestId: request.id, result: "deny" })}
              >
                Deny
              </button>
              <button
                className={styles.requestPrimaryButton}
                disabled={isResponding}
                type="button"
                onClick={() => onRespondToRequest({ requestId: request.id, result: "allow" })}
              >
                Allow
              </button>
            </div>
          ) : (
            <span className={styles.requestWaitingLabel}>Needs input</span>
          )}
        </article>
      ))}
    </section>
  );
}

function requestLabel(type: string) {
  switch (type) {
    case "permission":
      return "Permission";
    case "tool_confirmation":
    case "tool_call":
      return "Tool confirmation";
    case "question":
      return "Question";
    case "custom_input":
      return "Custom input";
    default:
      return "Request";
  }
}
