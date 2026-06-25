import {
  type KeyboardEventHandler,
  type PointerEventHandler,
} from "react";
import type { ChatRenderModel } from "../../../vela-chat-render-model/src";
import { ChatSurface } from "../surfaces/ChatSurface";
import { ScaledThumbnailCanvas } from "./ScaledThumbnailCanvas";
import styles from "./thumbnail.module.css";

export interface ConversationPreviewSurfaceProps {
  model: ChatRenderModel;
  canvasHeight?: number;
  canvasWidth?: number;
  scale?: number;
  onOpenSession?: () => void;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
}

export function ConversationPreviewSurface({
  model,
  canvasHeight = 520,
  canvasWidth = 840,
  scale,
  onOpenSession,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: ConversationPreviewSurfaceProps) {
  const body = (
    <ScaledThumbnailCanvas
      canvasHeight={canvasHeight}
      canvasWidth={canvasWidth}
      className={styles.conversationPreviewFrame}
      scale={scale}
    >
      <div
        className={styles.conversationPreviewSurface}
        data-conversation-preview="true"
        style={{
          height: `${canvasHeight}px`,
          minHeight: 0,
          width: `${canvasWidth}px`,
        }}
        inert
      >
        <ChatSurface
          draft=""
          historyPhase="ready"
          layout="contained"
          model={model}
          pendingAttachments={[]}
          onDraftChange={() => undefined}
          onSubmit={() => undefined}
        />
      </div>
    </ScaledThumbnailCanvas>
  );

  if (!onOpenSession) return body;

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpenSession();
  };

  return (
    <div
      className={styles.conversationPreviewButton}
      role="button"
      tabIndex={0}
      onClick={onOpenSession}
      onKeyDown={handleKeyDown}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {body}
    </div>
  );
}
