import TencentCloudChat from "@tencentcloud/chat";
import { PlatformApi } from "@vela/client-core";
import TIMUploadPlugin from "tim-upload-plugin";
import { createAppStore } from "../application/app-store";
import { ChannelChatService } from "../im/channel-chat-service";
import {
  TencentChatGateway,
  type TencentChatNamespace,
} from "../im/tencent-chat-gateway";
import { TencentMessagingPort } from "../im/tencent-messaging-port";
import { createCredentialStore } from "../storage/credential-store";
import {createDirectSendIntentStore} from "../storage/direct-send-intent-store";
import { resolveApiBaseUrl } from "./api-base-url";

export function createDefaultStore() {
  const apiBaseUrl = resolveApiBaseUrl({
    browserHostname:
      typeof globalThis.location === "undefined"
        ? undefined
        : globalThis.location.hostname,
    browserOrigin:
      typeof globalThis.location === "undefined"
        ? undefined
        : globalThis.location.origin,
    environmentUrl: process.env.EXPO_PUBLIC_VELA_API_URL,
    search:
      typeof globalThis.location === "undefined"
        ? undefined
        : globalThis.location.search,
  });
  const platform = new PlatformApi({
    baseUrl: apiBaseUrl,
    credentials: createCredentialStore(),
  });
  const namespace =
    TencentCloudChat as unknown as TencentChatNamespace;
  const gateway = new TencentChatGateway(namespace, {
    uploadPlugin: TIMUploadPlugin,
  });
  const chat = new ChannelChatService({
    conversationGroup: namespace.TYPES.CONV_GROUP,
    messageTypes: gateway.messageTypes,
    sdk: gateway,
  });
  const messaging = new TencentMessagingPort({ chat, gateway });

  return createAppStore({
    directSendIntents: createDirectSendIntentStore(),
    messaging,
    platform,
  });
}
