import { NativeChatMathProvider, NativeChatMermaidProvider } from "@opencraft/chat-render-native";
import type { ReactNode } from "react";
import { loadMobileChatMathHtml } from "./mobile-chat-math-asset.native";
import { loadMobileChatMermaidHtml } from "./mobile-chat-mermaid-asset.native";

export function CoreRenderCapabilities({ children }: { readonly children: ReactNode }) {
  return (
    <NativeChatMermaidProvider loadHtml={loadMobileChatMermaidHtml}>
      <NativeChatMathProvider loadHtml={loadMobileChatMathHtml}>
        {children}
      </NativeChatMathProvider>
    </NativeChatMermaidProvider>
  );
}
