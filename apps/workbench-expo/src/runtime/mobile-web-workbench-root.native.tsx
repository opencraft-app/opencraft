import { MOBILE_CONTAINER_ORIGIN, MOBILE_CONTAINER_VERSION, externalMobileUrl, mobileNavigationDisposition, parseMobileContainerRequest, type MobileContainerEvent } from "@opencraft/client-product/mobile-container";
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, BackHandler, Linking, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import WebView from "react-native-webview";

function PackagedWorkbench() {
  const runtimeId = useMemo(() => randomUUID(), []);
  const webView = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const ready = useRef(false);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    const asset = Asset.fromModule(require("../../assets/mobile-workbench.html") as number);
    void asset.downloadAsync().then(async () => {
      if (!asset.localUri) throw new Error("Packaged Workbench unavailable");
      const document = await new File(asset.localUri).text();
      if (!disposed) setHtml(document.replace("/*OPENCRAFT_MOBILE_IDENTITY*/", `window.opencraftMobile=${JSON.stringify({ version: MOBILE_CONTAINER_VERSION, runtimeId })};`));
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [runtimeId]);
  const source = useMemo(() => html === null ? null : { html, baseUrl: MOBILE_CONTAINER_ORIGIN + "/" }, [html]);
  const send = (event: MobileContainerEvent) => webView.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('opencraft-mobile',{detail:${JSON.stringify(event)}}));true;`);
  const visibility = () => send({ version: MOBILE_CONTAINER_VERSION, runtimeId, type: "visibility", active: AppState.currentState === "active" });
  useEffect(() => {
    const subscription = AppState.addEventListener("change", () => { if (ready.current) visibility(); });
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!ready.current || !canGoBack.current) return false;
      send({ version: MOBILE_CONTAINER_VERSION, runtimeId, type: "back" });
      return true;
    });
    return () => { subscription.remove(); back.remove(); };
  }, [runtimeId]);
  const openExternal = (url: string) => {
    const accepted = externalMobileUrl(url);
    if (accepted) void Linking.openURL(accepted).catch(() => undefined);
  };
  return <SafeAreaView edges={["top", "left", "right", "bottom"]} style={styles.root}>
    {failed ? <View style={styles.status}><Text>OpenCraft could not open. Close and reopen the app to retry.</Text></View>
      : source === null ? <View style={styles.status}><Text>OpenCraft</Text></View>
      : <WebView ref={webView} source={source} style={styles.root}
        // WebView's whitelist opens rejected URLs through Linking before our
        // callback. Route every URL through our narrower validated policy.
        originWhitelist={["*"]}
        javaScriptEnabled domStorageEnabled
        automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
        keyboardDisplayRequiresUserAction={false}
        setSupportMultipleWindows={false} mixedContentMode="never"
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        onShouldStartLoadWithRequest={request => {
          // Only the packaged initial document is admitted. No remote page can
          // replace the workbench and inherit the native bridge.
          const decision = mobileNavigationDisposition(request.url, request.isTopFrame !== false, !ready.current);
          if (decision === "external") openExternal(request.url);
          return decision === "allow";
        }}
        onOpenWindow={event => openExternal(event.nativeEvent.targetUrl)}
        onMessage={event => {
          const message = parseMobileContainerRequest(event.nativeEvent.data, runtimeId);
          if (!message) return;
          if (message.type === "ready") { ready.current = true; visibility(); }
          else if (message.type === "navigation") canGoBack.current = message.canGoBack;
          else openExternal(message.url);
        }}
        onError={() => { ready.current = false; setFailed(true); }}
        onContentProcessDidTerminate={() => { ready.current = false; setFailed(true); }}
        onRenderProcessGone={() => { ready.current = false; setFailed(true); }}
        {...(Platform.OS === "android" ? { overScrollMode: "never" as const } : { bounces: false })}
      />}
  </SafeAreaView>;
}
export function MobileWebWorkbenchRoot() {
  return <SafeAreaProvider><PackagedWorkbench /></SafeAreaProvider>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, status: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 } });
