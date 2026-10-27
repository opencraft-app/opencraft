import { ChatDocumentSessionView, type ChatExternalResourcePolicy, type ChatMediaSourceLoader, type ChatRenderContext, type ChatRenderTheme } from "@opencraft/chat-render-react";
import type { ChatDocumentDialect } from "@opencraft/chat-document";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "./styles";
import { NativeImageGalleryProvider } from "./renderers/image-gallery";
import { NativeChatLanguageProvider, type NativeChatLanguage } from "./presentation-language";

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
  readonly dialect?: ChatDocumentDialect;
  readonly language?: NativeChatLanguage;
  readonly theme?: ChatRenderTheme;
  readonly externalResourcePolicy?: ChatExternalResourcePolicy;
  readonly conversationId?: string | null;
  readonly turnId?: string | null;
  readonly hostId?: string | null;
  readonly cwd?: string | null;
  readonly onOpenResource?: ChatRenderContext["openResource"];
  readonly canOpenResource?: ChatRenderContext["canOpenResource"];
  readonly loadMediaSource?: ChatMediaSourceLoader;
  readonly onMeasurementRequest?: ChatRenderContext["requestMeasurement"];
}

function RawDocument({ source }: { readonly source: string }) {
  return <Text selectable style={styles.raw}>{source}</Text>;
}

export function NativeChatDocument(props: NativeChatDocumentProps) {
  const runtime = useNativeChatRenderRuntime();
  const context = useMemo<Omit<ChatRenderContext, "documentId" | "streaming">>(() => ({
    theme: props.theme ?? "light",
    externalResourcePolicy: props.externalResourcePolicy ?? "allow",
    conversationId: props.conversationId ?? null,
    turnId: props.turnId ?? null,
    hostId: props.hostId ?? null,
    cwd: props.cwd ?? null,
    allowWideBlocks: false,
    openResource: props.onOpenResource,
    canOpenResource: props.canOpenResource,
    loadMediaSource: props.loadMediaSource,
    requestMeasurement: props.onMeasurementRequest,
  }), [props.canOpenResource, props.conversationId, props.cwd, props.externalResourcePolicy, props.hostId, props.loadMediaSource, props.onMeasurementRequest, props.onOpenResource, props.theme, props.turnId]);
  const galleryScope = JSON.stringify([props.hostId ?? null, props.conversationId ?? null, props.cwd ?? null, props.documentId]);
  return (
    <View style={styles.root}>
      <NativeChatLanguageProvider language={props.language ?? "en"}>
        <NativeImageGalleryProvider scopeKey={galleryScope}>
          <ChatDocumentSessionView
            context={context}
            dialect={props.dialect}
            documentId={props.documentId}
            fallback={({ source }) => <RawDocument source={source} />}
            runtime={runtime}
            source={props.source}
            streaming={props.streaming ?? false}
          />
        </NativeImageGalleryProvider>
      </NativeChatLanguageProvider>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { minWidth: 0 },
  raw: { color: theme.color.text.primary, fontSize: theme.platformTypography.chat.fontSize, lineHeight: theme.platformTypography.chat.lineHeight },
}));
