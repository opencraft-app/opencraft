import type { ChatRenderRuntime } from "@opencraft/chat-render-react";
import { createContext, use, useContext, type ReactNode } from "react";

import { createWebChatRenderRuntime } from "./runtime";

const WebChatRenderRuntimeContext = createContext<ChatRenderRuntime | null>(null);
let fallbackRuntime: Promise<ChatRenderRuntime> | null = null;

function getFallbackRuntime(): Promise<ChatRenderRuntime> {
  fallbackRuntime ??= createWebChatRenderRuntime();
  return fallbackRuntime;
}

/** Application-owned runtime; the lazy fallback exists only for library consumers. */
export function WebChatRenderRuntimeProvider({
  children,
  runtime,
}: {
  readonly children: ReactNode;
  readonly runtime: ChatRenderRuntime;
}) {
  return (
    <WebChatRenderRuntimeContext.Provider value={runtime}>
      {children}
    </WebChatRenderRuntimeContext.Provider>
  );
}

export function useWebChatRenderRuntime(): ChatRenderRuntime {
  const runtime = useContext(WebChatRenderRuntimeContext);
  return runtime ?? use(getFallbackRuntime());
}
