import {
  type KeyboardEventHandler,
  type PointerEventHandler,
} from "react";
import type { ChatRenderModel } from "../../../../packages/vela-chat-render-model/src";
import type { ConversationScrollControllerDebug } from "../../../../packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController";
import { ConversationPreviewSurface } from "../../../../packages/vela-chat-web/src";
import styles from "./session-preview.module.css";

export const SESSION_PREVIEW_SCALE = 0.25;

export interface SessionPreviewPointerHandlers {
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
}

export interface SessionPreviewWindowContentProps extends SessionPreviewPointerHandlers {
  followOutputToken?: number;
  model: ChatRenderModel;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onOpenSession?: () => void;
  title: string;
}

export function SessionPreviewWindowContent({
  followOutputToken,
  model,
  onConversationScrollDebugChange,
  onOpenSession,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  title,
}: SessionPreviewWindowContentProps) {
  return (
    <main className={styles.sessionPreviewApp}>
      <div className={styles.sessionPreviewFrame}>
        <ConversationPreviewSurface
          followOutputToken={followOutputToken}
          model={model}
          scale={SESSION_PREVIEW_SCALE}
          onConversationScrollDebugChange={onConversationScrollDebugChange}
          onOpenSession={onOpenSession}
          onPointerCancel={onPointerCancel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        <div className={styles.sessionPreviewTitle} title={title}>
          {title}
        </div>
      </div>
    </main>
  );
}

export interface SessionPreviewStatusProps extends SessionPreviewPointerHandlers {
  label: string;
  onOpenSession?: () => void;
  role?: "alert" | "status";
  value: string;
}

export function SessionPreviewStatus({
  label,
  onOpenSession,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  role,
  value,
}: SessionPreviewStatusProps) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
    </>
  );
  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (!onOpenSession || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onOpenSession();
  };

  return (
    <main className={styles.sessionPreviewApp}>
      {onOpenSession ? (
        <div
          className={styles.sessionPreviewStatus}
          role="button"
          tabIndex={0}
          onClick={onOpenSession}
          onKeyDown={handleKeyDown}
          onPointerCancel={onPointerCancel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {content}
        </div>
      ) : (
        <div className={styles.sessionPreviewStatus} role={role}>
          {content}
        </div>
      )}
    </main>
  );
}
