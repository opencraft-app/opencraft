import {
  type MouseEventHandler,
  type PointerEventHandler,
} from "react";
import { X } from "lucide-react";
import type { ChatRenderModel } from "../../../../packages/vela-chat-render-model/src";
import type { ConversationScrollControllerDebug } from "../../../../packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController";
import { ConversationPreviewSurface } from "../../../../packages/vela-chat-web/src";
import styles from "./session-preview.module.css";

export const SESSION_PREVIEW_SCALE = 0.25;

export interface SessionPreviewPointerHandlers {
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
}

export interface SessionPreviewWindowContentProps extends SessionPreviewPointerHandlers {
  followOutputToken?: number;
  isCloseVisible?: boolean;
  isDragging?: boolean;
  model: ChatRenderModel;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onCloseMonitor?: () => void;
  title: string;
}

export function SessionPreviewWindowContent({
  followOutputToken,
  isCloseVisible = false,
  isDragging = false,
  model,
  onConversationScrollDebugChange,
  onCloseMonitor,
  onPointerCancel,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onPointerMove,
  onPointerUp,
  title,
}: SessionPreviewWindowContentProps) {
  return (
    <main className={styles.sessionPreviewApp}>
      <div
        className={styles.sessionPreviewFrame}
        data-close-visible={isCloseVisible ? "true" : "false"}
        data-dragging={isDragging ? "true" : "false"}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <ConversationPreviewSurface
          followOutputToken={followOutputToken}
          model={model}
          scale={SESSION_PREVIEW_SCALE}
          onConversationScrollDebugChange={onConversationScrollDebugChange}
        />
        {onCloseMonitor ? (
          <SessionPreviewCloseButton
            isVisible={isCloseVisible}
            onClose={onCloseMonitor}
          />
        ) : null}
        <div className={styles.sessionPreviewTitle} title={title}>
          {title}
        </div>
      </div>
    </main>
  );
}

export interface SessionPreviewStatusProps extends SessionPreviewPointerHandlers {
  isCloseVisible?: boolean;
  isDragging?: boolean;
  label: string;
  onCloseMonitor?: () => void;
  role?: "alert" | "status";
  value: string;
}

export function SessionPreviewStatus({
  isCloseVisible = false,
  isDragging = false,
  label,
  onCloseMonitor,
  onPointerCancel,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
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

  return (
    <main className={styles.sessionPreviewApp}>
      <div
        className={styles.sessionPreviewFrame}
        data-close-visible={isCloseVisible ? "true" : "false"}
        data-dragging={isDragging ? "true" : "false"}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className={styles.sessionPreviewStatus} role={role}>
          {content}
        </div>
        {onCloseMonitor ? (
          <SessionPreviewCloseButton
            isVisible={isCloseVisible}
            onClose={onCloseMonitor}
          />
        ) : null}
      </div>
    </main>
  );
}

function SessionPreviewCloseButton({
  isVisible,
  onClose,
}: {
  isVisible: boolean;
  onClose: () => void;
}) {
  const handlePointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    event.stopPropagation();
  };
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    event.stopPropagation();
    onClose();
  };

  return (
    <button
      type="button"
      className={styles.sessionPreviewCloseButton}
      aria-label="Close monitor"
      data-visible={isVisible ? "true" : "false"}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
    >
      <X size={12} strokeWidth={2.4} />
    </button>
  );
}
