import TencentCloudChat from "@tencentcloud/chat";
import TIMUploadPlugin from "tim-upload-plugin";

import { ChannelChatService } from "./channel-chat-service";
import {
  TencentChatGateway,
  type TencentChatNamespace,
} from "./tencent-chat-gateway";
import { TencentMessagingPort } from "./tencent-messaging-port";

export interface TencentWebMessagingOptions {
  readonly namespace?: TencentChatNamespace;
  readonly uploadPlugin?: unknown;
}

export function createTencentWebMessagingPort(
  options: TencentWebMessagingOptions = {},
): TencentMessagingPort {
  const namespace = options.namespace
    ?? TencentCloudChat as unknown as TencentChatNamespace;
  const gateway = new TencentChatGateway(namespace, {
    uploadPlugin: options.uploadPlugin ?? TIMUploadPlugin,
  });
  const chat = new ChannelChatService({
    conversationGroup: namespace.TYPES.CONV_GROUP,
    messageTypes: gateway.messageTypes,
    sdk: gateway,
  });
  return new TencentMessagingPort({ chat, gateway });
}
