import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import { Suspense, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, View } from "react-native";

import type { BotSummary } from "@opencraft/mobile-bot-bridge";
import { NativeChatMathProvider, NativeChatMermaidProvider } from "@opencraft/chat-render-native";
import { createConversationReturnProbe } from "@opencraft/workbench-runtime";
import { LightVelaHermesTransport, type LightVelaAccountPort } from "@opencraft/plugin-lightvela-hermes/transport";

import { mobileAccount } from "../runtime/mobile-account-instance";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log.ios";
import { mobileConversationDisplayStorage, mobileConversationDraftStorage } from "../runtime/mobile-conversation-drafts.native";
import { loadMobileChatMermaidHtml } from "../runtime/mobile-chat-mermaid-asset.native";
import { loadMobileChatMathHtml } from "../runtime/mobile-chat-math-asset.native";
import { createExpoPresentationRuntime, ExpoPresentationRuntimeProvider } from "../runtime/presentation-runtime";
import { createExpoWorkbenchApplication, WorkbenchRuntimeProvider, type ExpoWorkbenchApplication } from "../runtime/runtime-context";
import { WorkbenchFrameShared } from "./workbench-frame.shared";

const presentationRuntime = createExpoPresentationRuntime();

/** Bind one native Chat runtime to the physical instance and Hermes Profile in the Bot catalog. */
function selectedBotAccount(bot: BotSummary, credentialScope: string): LightVelaAccountPort {
  return {
    subscribe: mobileAccount.subscribe,
    getSnapshot: () => {
      const snapshot = mobileAccount.getSnapshot();
      return { ...snapshot, activeBotId: snapshot.phase === "authenticated" ? bot.instanceId : null, credentialScope };
    },
    request: (path, init) => mobileAccount.request(path, init),
    resolveActiveBot: async () => {
      if (mobileAccount.getSnapshot().phase !== "authenticated") throw new Error("Sign in to LightVela first");
      return { instanceId: bot.instanceId };
    },
  };
}

function ConnectedChat({ bot, credentialScope, language, active }: {
  readonly bot: BotSummary;
  readonly credentialScope: string;
  readonly language: "zh-CN" | "en";
  readonly active: boolean;
}) {
  const [application] = useState<ExpoWorkbenchApplication>(() => {
    const botDraftScope = `${credentialScope}.${encodeURIComponent(bot.instanceId)}.${encodeURIComponent(bot.profileId)}`;
    return createExpoWorkbenchApplication({
      hostId: "velahermes0",
      hostLabel: bot.name,
      // Stable within one account and Bot; first accepted send discards it.
      initialDraftId: `mobile-home:${bot.instanceId}:${bot.profileId}`,
      draftNamespace: botDraftScope,
      draftStorage: mobileConversationDraftStorage(credentialScope, botDraftScope),
      displayNamespace: botDraftScope,
      displayStorage: mobileConversationDisplayStorage(credentialScope, botDraftScope),
      transport: new LightVelaHermesTransport({
        account: selectedBotAccount(bot, credentialScope),
        onRequestFailure: ({ method, kind }) => {
          mobileDeveloperLog.log(method === "model/list" ? "chat.model.list.failed" : "chat.request.failed", {
            kind: kind === "timeout" ? 1 : kind === "unavailable" ? 2 : 3,
          });
        },
        profile: bot.profileId === "main" ? "default" : bot.profileId,
        bufferHttpResponses: true,
        sha1: async data => {
          const bytes = new Uint8Array(data.byteLength);
          bytes.set(data);
          return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA1, bytes));
        },
        sha256: async data => {
          const bytes = new Uint8Array(data.byteLength);
          bytes.set(data);
          return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
        },
      }),
      transportEndpoint: null,
    });
  });
  const returnProbe = useRef(createConversationReturnProbe()).current;
  useEffect(() => () => { void application.dispose(); }, [application]);
  useEffect(() => {
    const revalidate = () => {
      if (!active || application.runtime.getSnapshot().phase !== "ready") return;
      const lease = application.coordinator.getActiveThreadLease();
      if (lease) void lease.retryRestore().catch(() => undefined);
    };
    if (!active) returnProbe.background(Date.now());
    else if (returnProbe.foreground(Date.now())) revalidate();
    const app = AppState.addEventListener("change", state => {
      if (state !== "active") returnProbe.background(Date.now());
      else if (active && returnProbe.foreground(Date.now())) revalidate();
    });
    const network = Network.addNetworkStateListener(state => {
      if (state.isConnected === false || state.isInternetReachable === false) returnProbe.offline();
      if (active && state.isConnected === true && returnProbe.online(Date.now())) revalidate();
    });
    return () => { app.remove(); network.remove(); };
  }, [active, application, returnProbe]);
  return <WorkbenchRuntimeProvider application={application}>
    <NativeChatMermaidProvider loadHtml={loadMobileChatMermaidHtml}>
      <NativeChatMathProvider loadHtml={loadMobileChatMathHtml}>
        <WorkbenchFrameShared platformLayout="native" embedded keyboardActive={active} language={language} />
      </NativeChatMathProvider>
    </NativeChatMermaidProvider>
  </WorkbenchRuntimeProvider>;
}

export function MobileOpenCraftChat(props: {
  readonly bot: BotSummary;
  readonly credentialScope: string;
  readonly language: "zh-CN" | "en";
  readonly active: boolean;
}) {
  return <Suspense fallback={<View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><ActivityIndicator /></View>}>
    <ExpoPresentationRuntimeProvider runtime={presentationRuntime}>
      <ConnectedChat {...props} />
    </ExpoPresentationRuntimeProvider>
  </Suspense>;
}
