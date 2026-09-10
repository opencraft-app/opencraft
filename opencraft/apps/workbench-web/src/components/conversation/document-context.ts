import type {
  AutomationUpdateTimelineBlock,
  TimelineBlock,
  TurnDiffTimelineBlock,
} from "@opencraft/chat-core";
import type {
  ChatMediaSourceLoader,
  ChatMeasurementEvent,
  ChatRenderTheme,
  ChatResourceDecision,
} from "@opencraft/chat-render-web";
import { createContext } from "react";

/**
 * Product-host capabilities consumed by otherwise reusable conversation
 * renderers. Filesystem resolution and mutations stay outside ChatUI; the
 * renderer owns only presentation and user intent.
 */
export interface ConversationDocumentContextValue {
  readonly conversationId: string | null;
  readonly cwd: string | null;
  readonly hostId: string | null;
  /** Root-owned appearance projection. Renderers must never infer theme from DOM. */
  readonly theme: ChatRenderTheme;
  /** Viewport-owned transaction ingress for renderer geometry changes. */
  readonly onMeasurementRequest?: (event: ChatMeasurementEvent) => void;
  readonly onOpenResource?: (target: string, decision: ChatResourceDecision) => void;
  /** Host/AppServer byte loader for Markdown-local media. */
  readonly loadMediaSource?: ChatMediaSourceLoader;
  /** Host-owned automations editor; ChatUI owns only the citation card. */
  readonly onOpenAutomation?: (block: AutomationUpdateTimelineBlock) => void;
  /** Host-owned review surface; ChatUI only owns the resource-card contract. */
  readonly onReviewTurnDiff?: (block: TurnDiffTimelineBlock, path?: string) => void;
  /** Host-owned git/apply-patch mutation used by the TurnDiff Undo/Reapply button. */
  readonly onApplyTurnDiff?: (block: TurnDiffTimelineBlock, action: "undo" | "reapply") => Promise<void>;
  /** Host maps AppServer-local image paths to a browser-readable URL. */
  readonly resolveImageSource?: (path: string) => string | null;
  /** Optional host override for generated-image preview/navigation. */
  readonly onOpenGeneratedImage?: (block: Extract<TimelineBlock, { type: "image" }>) => void;
  /** Optional host resolver for durable/file-backed generated image sources. */
  readonly resolveGeneratedImageSource?: (block: Extract<TimelineBlock, { type: "image" }>) => string | null;
  /** The image editor belongs to the product host; ChatUI owns only its entry point. */
  readonly onEditGeneratedImage?: (block: Extract<TimelineBlock, { type: "image" }>) => void;
}

export const ConversationDocumentContext = createContext<ConversationDocumentContextValue>({
  conversationId: null,
  cwd: null,
  hostId: null,
  theme: "light",
});

export function browserReadableImageSource(
  path: string,
  resolve: ConversationDocumentContextValue["resolveImageSource"],
): string | null {
  const resolved = resolve?.(path) ?? null;
  if (resolved !== null) return resolved;
  return /^(?:blob:|data:|https?:\/\/)/iu.test(path) ? path : null;
}
