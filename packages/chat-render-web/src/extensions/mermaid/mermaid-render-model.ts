import type { ChatRenderTheme } from "@opencraft/chat-render-react";

export const MERMAID_INITIAL_HEIGHT = 240;
export const MERMAID_REVEAL_DURATION_MS = 180;

export type MermaidRenderStatus = "rendering" | "rendered" | "error";

/**
 * Layout authority for one Mermaid block.
 *
 * The last committed height deliberately survives a new render key. This is
 * the invariant that prevents a theme change or a streaming replacement from
 * collapsing the transcript while the next SVG is being prepared.
 */
export interface MermaidRenderState {
  readonly activeKey: string;
  readonly committedHeight: number | null;
  readonly revealedKey: string | null;
  readonly status: MermaidRenderStatus;
  readonly error: string | null;
}

export type MermaidRenderEvent =
  | { readonly type: "begin"; readonly key: string }
  | {
      readonly type: "rendered";
      readonly key: string;
      readonly height: number;
    }
  | { readonly type: "reveal"; readonly key: string }
  | { readonly type: "failed"; readonly key: string; readonly error: string };

export function createMermaidRenderKey(
  theme: ChatRenderTheme,
  code: string,
): string {
  return `${theme}::${code}`;
}

export function createMermaidRenderState(key: string): MermaidRenderState {
  return {
    activeKey: key,
    committedHeight: null,
    revealedKey: null,
    status: "rendering",
    error: null,
  };
}

function normalizeMeasuredHeight(height: number): number {
  return Number.isFinite(height) && height > 0
    ? Math.max(1, Math.round(height))
    : MERMAID_INITIAL_HEIGHT;
}

export function reduceMermaidRenderState(
  state: MermaidRenderState,
  event: MermaidRenderEvent,
): MermaidRenderState {
  switch (event.type) {
    case "begin":
      if (event.key === state.activeKey && state.status === "rendering") {
        return state;
      }
      return {
        activeKey: event.key,
        committedHeight: state.committedHeight,
        revealedKey: state.revealedKey,
        status: "rendering",
        error: null,
      };
    case "rendered": {
      if (event.key !== state.activeKey) return state;
      const committedHeight = normalizeMeasuredHeight(event.height);
      if (
        state.status === "rendered" &&
        state.committedHeight === committedHeight
      ) {
        return state;
      }
      return {
        ...state,
        committedHeight,
        status: "rendered",
        error: null,
      };
    }
    case "reveal":
      if (
        event.key !== state.activeKey ||
        state.status !== "rendered" ||
        state.revealedKey === event.key
      ) {
        return state;
      }
      return { ...state, revealedKey: event.key };
    case "failed":
      if (event.key !== state.activeKey) return state;
      return {
        ...state,
        status: "error",
        error: event.error,
      };
  }
}

export function mermaidShellHeight(state: MermaidRenderState): number {
  return state.committedHeight ?? MERMAID_INITIAL_HEIGHT;
}

export function isMermaidRenderRevealed(state: MermaidRenderState): boolean {
  return state.status === "rendered" && state.revealedKey === state.activeKey;
}

export { prepareMermaidSource } from "@opencraft/chat-render-react";
