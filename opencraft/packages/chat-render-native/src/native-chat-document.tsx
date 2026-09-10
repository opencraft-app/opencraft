import { ChatDocumentSessionView, type ChatRenderContext, type ChatRenderTheme } from "@opencraft/chat-render-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { ChatRenderRuntime } from "@opencraft/chat-render-react";

const NativeChatRenderRuntimeContext = createContext<ChatRenderRuntime | null>(null);

export function NativeChatRenderRuntimeProvider({
  children,
  runtime,
}: {
  readonly children: ReactNode;
  readonly runtime: ChatRenderRuntime;
}) {
  return (
    <NativeChatRenderRuntimeContext.Provider value={runtime}>
      {children}
    </NativeChatRenderRuntimeContext.Provider>
  );
}

export function useNativeChatRenderRuntime(): ChatRenderRuntime {
  const runtime = useContext(NativeChatRenderRuntimeContext);
  if (runtime === null) throw new Error("NativeChatRenderRuntimeProvider is missing");
  return runtime;
}

export interface NativeChatDocumentProps {
  readonly documentId: string;
  readonly source: string;
  readonly streaming?: boolean;
  readonly theme?: ChatRenderTheme;
  readonly hostId?: string | null;
  readonly cwd?: string | null;
  readonly onOpenResource?: (target: string) => void;
}

function RawDocument({ source }: { readonly source: string }) {
  return <Text selectable style={styles.raw}>{source}</Text>;
}

export function NativeChatDocument(props: NativeChatDocumentProps) {
  const runtime = useNativeChatRenderRuntime();
  const context = useMemo<Omit<ChatRenderContext, "documentId" | "streaming">>(() => ({
    theme: props.theme ?? "light",
    externalResourcePolicy: "allow",
    hostId: props.hostId ?? null,
    cwd: props.cwd ?? null,
    allowWideBlocks: false,
    openResource: props.onOpenResource,
  }), [props.cwd, props.hostId, props.onOpenResource, props.theme]);
  return (
    <View style={styles.root}>
      <ChatDocumentSessionView
        context={context}
        documentId={props.documentId}
        fallback={({ source }) => <RawDocument source={source} />}
        runtime={runtime}
        source={props.source}
        streaming={props.streaming ?? false}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { minWidth: 0 },
  raw: { color: theme.color.text.primary, fontSize: theme.platformTypography.chat.fontSize, lineHeight: theme.platformTypography.chat.lineHeight },
}));
