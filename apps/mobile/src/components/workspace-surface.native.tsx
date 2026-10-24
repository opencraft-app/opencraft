import { MOBILE_CONTAINER_ORIGIN, MOBILE_CONTAINER_VERSION, externalMobileUrl, mobileNavigationDisposition, parseMobileContainerRequest, type MobileContainerEvent } from "@opencraft/client-product/mobile-container";
import { useIntl } from "@opencraft/i18n/react";
import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { Asset } from "expo-asset";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { mobilePreviewAssetUri } from "../runtime/mobile-preview-asset";
import { File } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import WebView from "react-native-webview";
import { isSelfHostedNavigation, type MobileContentSource } from "../runtime/content-source";
import { mobileMessages as m } from "../runtime/mobile-messages";

export function WorkspaceSurface({ source: content, dark, onAppearance }: { source: MobileContentSource; dark: boolean; onAppearance(value: { resolvedTheme: "light" | "dark"; edgeBackgroundColor: string }): void }) {
  const intl = useIntl();
  const theme = nativeThemes[dark ? "dark" : "light"];
  const bundled = content.kind === "bundled";
  const [attempt, setAttempt] = useState(0);
  const runtimeId = useMemo(() => randomUUID(), [attempt]);
  const webView = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const ready = useRef(false);
  const active = useRef(true);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    active.current = true; ready.current = false; canGoBack.current = false; setFailed(false); setHtml(null);
    let current = true;
    if (bundled) {
      const packaged = Asset.fromModule(require("../../assets/mobile-workbench.html") as number);
      const uri = Constants.executionEnvironment === ExecutionEnvironment.StoreClient && !packaged.localUri
        ? mobilePreviewAssetUri(packaged.uri, Constants.experienceUrl) : packaged.uri;
      const asset = uri === packaged.uri ? packaged : new Asset({
        name: packaged.name, type: packaged.type, hash: packaged.hash, uri,
      });
      void asset.downloadAsync().then(async () => {
        if (!asset.localUri) throw new Error("asset.missing");
        const document = await new File(asset.localUri).text();
        if (current) setHtml(document.replace("/*OPENCRAFT_MOBILE_IDENTITY*/", `window.opencraftMobile=${JSON.stringify({ version: MOBILE_CONTAINER_VERSION, runtimeId })};`));
      }).catch(() => { if (current) setFailed(true); });
    }
    return () => { current = false; active.current = false; ready.current = false; };
  }, [bundled, runtimeId]);
  const source = useMemo(() => content.kind === "self-hosted" ? { uri: content.url }
    : html === null ? null : { html, baseUrl: MOBILE_CONTAINER_ORIGIN + "/" }, [content, html]);
  const send = (event: MobileContainerEvent) => {
    if (active.current && bundled) webView.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('opencraft-mobile',{detail:${JSON.stringify(event)}}));true;`);
  };
  useEffect(() => {
    const subscription = AppState.addEventListener("change", () => {
      if (ready.current) send({ version: MOBILE_CONTAINER_VERSION, runtimeId, type: "visibility", active: AppState.currentState === "active" });
    });
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!active.current || !canGoBack.current) return false;
      if (bundled) {
        if (!ready.current) return false;
        send({ version: MOBILE_CONTAINER_VERSION, runtimeId, type: "back" });
      } else webView.current?.goBack();
      return true;
    });
    return () => { subscription.remove(); back.remove(); };
  }, [runtimeId, bundled]);
  const openExternal = (url: string) => {
    const accepted = externalMobileUrl(url);
    if (accepted) void Linking.openURL(accepted).catch(() => undefined);
  };
  const fail = () => { if (active.current) { ready.current = false; canGoBack.current = false; setFailed(true); } };
  return <View style={styles.root}>
    {failed ? <View style={styles.status}>
      <Text style={{ color: theme.color.text.primary }}>{intl.formatMessage(m.failed)}</Text>
      <Pressable accessibilityRole="button" style={styles.retry} onPress={() => setAttempt(value => value + 1)}>
        <Text style={{ color: theme.color.accent.blue }}>{intl.formatMessage(m.retry)}</Text>
      </Pressable>
    </View> : source === null ? <View style={styles.status}><ActivityIndicator color={theme.color.text.secondary} /><Text style={{ color: theme.color.text.primary }}>{intl.formatMessage(m.loading)}</Text></View>
      : <WebView key={runtimeId} ref={webView} source={source} style={[styles.root, { backgroundColor: theme.material.content }]}
        originWhitelist={["*"]} javaScriptEnabled domStorageEnabled
        incognito={!bundled} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
        automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
        keyboardDisplayRequiresUserAction={false} setSupportMultipleWindows={false} mixedContentMode="never"
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        onShouldStartLoadWithRequest={request => {
          if (!active.current) return false;
          if (!bundled) {
            if (isSelfHostedNavigation(content, request.url)) return true;
            if (request.isTopFrame !== false) openExternal(request.url);
            return false;
          }
          const decision = mobileNavigationDisposition(request.url, request.isTopFrame !== false, !ready.current);
          if (decision === "external") openExternal(request.url);
          return decision === "allow";
        }}
        onOpenWindow={event => openExternal(event.nativeEvent.targetUrl)}
        onNavigationStateChange={state => { if (!bundled) canGoBack.current = state.canGoBack; }}
        {...(bundled ? { onMessage: (event: { nativeEvent: { data: string } }) => {
          if (!active.current) return;
          const message = parseMobileContainerRequest(event.nativeEvent.data, runtimeId);
          if (!message) return;
          if (message.type === "ready") {
            ready.current = true;
            send({ version: MOBILE_CONTAINER_VERSION, runtimeId, type: "visibility", active: AppState.currentState === "active" });
          } else if (message.type === "navigation") canGoBack.current = message.canGoBack;
          else if (message.type === "appearance") onAppearance(message);
          else openExternal(message.url);
        } } : {})}
        onError={fail} onHttpError={event => { if (event.nativeEvent.url === (content.kind === "self-hosted" ? content.url : "")) fail(); }}
        onContentProcessDidTerminate={fail} onRenderProcessGone={fail}
        {...(Platform.OS === "android" ? { overScrollMode: "never" as const } : { bounces: false })}
      />}
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, status: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }, retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 16 } });
