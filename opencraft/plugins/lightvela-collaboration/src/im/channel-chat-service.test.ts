import "./test-compat";

import {
  ChannelChatService,
  type ChatSdk,
  type SdkMessage,
} from "./channel-chat-service";

function textMessage(overrides: Partial<SdkMessage> = {}): SdkMessage {
  return {
    ID: "message-1",
    atUserList: [],
    avatar: "",
    conversationID: "GROUPtopic-1",
    flow: "in",
    from: "agent-1",
    nameCard: "研究助手",
    nick: "Agent",
    payload: { text: "收到，我来处理。" },
    status: "success",
    time: 1_785_400_000,
    type: "TIMTextElem",
    ...overrides,
  };
}

describe("ChannelChatService", () => {
  it("loads Topic history from Tencent IM using the SDK cursor", async () => {
    const getMessageList = jest.fn(async () => ({
      data: {
        isCompleted: false,
        messageList: [textMessage()],
        nextReqMessageID: "cursor-2",
      },
    }));
    const sdk: ChatSdk = {
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(),
      getMessageList,
      sendMessage: jest.fn(),
    };
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      messageText: "TIMTextElem",
      sdk,
    });

    const page = await service.loadHistory(
      {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      "cursor-1",
    );

    expect(getMessageList).toHaveBeenCalledWith({
      conversationID: "GROUPtopic-1",
      nextReqMessageID: "cursor-1",
    });
    expect(page.nextCursor).toBe("cursor-2");
    expect(page.completed).toBe(false);
    expect(page.messages).toEqual([
      expect.objectContaining({
        id: "message-1",
        senderName: "研究助手",
        text: "收到，我来处理。",
      }),
    ]);
  });

  it("maps Tencent Topic membership rejection to IM_NOT_MEMBER", async () => {
    const providerError = Object.assign(new Error("not member"), {code: 10007});
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(async () => {
          throw providerError;
        }),
        sendMessage: jest.fn(),
      },
    });

    await expect(
      service.loadHistory({
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      }),
    ).rejects.toMatchObject({
      code: "IM_NOT_MEMBER",
      platformCode: "tencent_10007",
    });
  });

  it("keeps provider code 10007 unchanged outside Topic history", async () => {
    const providerError = Object.assign(new Error("not member"), {code: 10007});
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(async () => {
          throw providerError;
        }),
        sendMessage: jest.fn(),
      },
    });

    await expect(
      service.loadHistory({
        conversationId: "GROUPdirect-1",
        directConversationId: "direct-1",
        imGroupId: "direct-1",
        targetId: "direct-1",
      }),
    ).rejects.toBe(providerError);
  });

  it("sends a real Tencent @ message to Agent imUserIds", async () => {
    const draft = textMessage({
      ID: "local-message-1",
      atUserList: ["agent_im_1"],
      flow: "out",
      from: "human-1",
      payload: { text: "@研究助手 请总结。" },
      status: "unSend",
    });
    const confirmed = textMessage({
      ID: "remote-message-1",
      atUserList: ["agent_im_1"],
      flow: "out",
      from: "human-1",
      payload: { text: "@研究助手 请总结。" },
    });
    const createTextAtMessage = jest.fn(() => draft);
    const sendMessage = jest.fn(async () => ({
      data: { message: confirmed },
    }));
    const sdk: ChatSdk = {
      createTextAtMessage,
      createTextMessage: jest.fn(),
      getMessageList: jest.fn(),
      sendMessage,
    };
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      messageText: "TIMTextElem",
      sdk,
    });

    const sent = await service.sendText({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "request-1",
      mentions: [
        {
          displayName: "研究助手",
          imUserId: "agent_im_1",
          memberId: "member-agent-1",
          memberKind: "agent",
        },
      ],
      text: "@研究助手 请总结。",
    });

    expect(createTextAtMessage).toHaveBeenCalledWith({
      cloudCustomData: JSON.stringify({
        clientRequestId: "request-1",
        schema: "vela.client-message/v2",
      }),
      conversationType: "GROUP",
      payload: {
        atUserList: ["agent_im_1"],
        text: "@研究助手 请总结。",
      },
      to: "topic-1",
    });
    expect(sendMessage).toHaveBeenCalledWith(draft);
    expect(sent).toMatchObject({
      delivery: { state: "sent" },
      id: "remote-message-1",
      mentions: ["agent_im_1"],
    });
  });

  it("writes composer submission and quote metadata into one versioned envelope", async () => {
    const createTextMessage = jest.fn((_options: {cloudCustomData: string}) =>
      textMessage({ID: "local-message-1", flow: "out", status: "unSend"}),
    );
    const sdk: ChatSdk = {
      createTextAtMessage: jest.fn(),
      createTextMessage,
      getMessageList: jest.fn(),
      sendMessage: jest.fn(async (draft) => ({data: {message: draft}})),
    };
    const service = new ChannelChatService({conversationGroup: "GROUP", sdk});

    await service.sendText({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "request-1",
      mentions: [],
      quote: {
        messageId: "root-1",
        preview: "先核对接口",
        senderId: "human-2",
        senderName: "小林",
      },
      submission: {
        count: 2,
        final: true,
        id: "submission-1",
        index: 1,
        role: "commit",
      },
      text: "已处理",
    });

    const options = createTextMessage.mock.calls[0]?.[0] as {
      cloudCustomData: string;
    };
    expect(JSON.parse(options.cloudCustomData)).toEqual({
      clientRequestId: "request-1",
      quote: {
        messageId: "root-1",
        preview: "先核对接口",
        senderId: "human-2",
        senderName: "小林",
      },
      schema: "vela.composer-submission/v1",
      submission: {
        count: 2,
        final: true,
        id: "submission-1",
        index: 1,
        role: "commit",
      },
    });
  });

  it("does not emit atUserList for a direct conversation", async () => {
    const createTextMessage = jest.fn(() =>
      textMessage({ID: "local-message-1", flow: "out", status: "unSend"}),
    );
    const sdk: ChatSdk = {
      createTextAtMessage: jest.fn(),
      createTextMessage,
      getMessageList: jest.fn(),
      sendMessage: jest.fn(async (draft) => ({data: {message: draft}})),
    };
    const service = new ChannelChatService({conversationGroup: "GROUP", sdk});

    await service.sendText({
      channel: {
        conversationId: "GROUPdirect-1",
        directConversationId: "direct-1",
        imGroupId: "direct-1",
        targetId: "direct-1",
      },
      clientRequestId: "request-1",
      mentions: [
        {
          displayName: "研究助手",
          imUserId: "agent_im_1",
          memberId: "member-agent-1",
          memberKind: "agent",
        },
      ],
      text: "@研究助手 请处理",
    });

    expect(sdk.createTextAtMessage).not.toHaveBeenCalled();
    expect(createTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({payload: {text: "@研究助手 请处理"}}),
    );
  });

  it("classifies uncertain sends and reconciles them by client request id", async () => {
    const draft = textMessage({
      cloudCustomData: JSON.stringify({clientRequestId: "request-1"}),
      flow: "out",
      ID: "local-message-1",
      status: "unSend",
    });
    const sdk: ChatSdk = {
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(() => draft),
      getMessageList: jest.fn(async () => ({
        data: {isCompleted: true, messageList: []},
      })),
      sendMessage: jest.fn(async () => {
        throw new Error("network timeout");
      }),
    };
    const service = new ChannelChatService({conversationGroup: "GROUP", sdk});
    const channel = {
      channelId: "channel-1",
      conversationId: "GROUPtopic-1",
      imGroupId: "community-1",
      imTopicId: "topic-1",
      targetId: "topic-1",
    };

    await expect(
      service.sendText({
        channel,
        clientRequestId: "request-1",
        mentions: [],
        text: "hello",
      }),
    ).rejects.toMatchObject({outcome: "uncertain", retryable: false});
    await expect(
      service.reconcileMessage({channel, clientRequestId: "request-1"}),
    ).resolves.toEqual({state: "pending"});

    const confirmed = textMessage({
      cloudCustomData: JSON.stringify({clientRequestId: "request-1"}),
      flow: "out",
      ID: "remote-message-1",
      status: "success",
    });
    service.normalizeMessages([confirmed]);
    await expect(
      service.reconcileMessage({channel, clientRequestId: "request-1"}),
    ).resolves.toEqual({
      message: expect.objectContaining({id: "remote-message-1"}),
      state: "sent",
    });
  });

  it("sends Server 内私信 through its Tencent two-member group", async () => {
    const confirmed = textMessage({
      conversationID: "GROUPan_dm_direct",
      flow: "out",
      from: "human-1",
      payload: {text: "私信收到"},
    });
    const createTextMessage = jest.fn(() => confirmed);
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage,
        getMessageList: jest.fn(),
        sendMessage: jest.fn(async () => ({
          data: {message: confirmed},
        })),
      },
    });

    await service.sendText({
      channel: {
        conversationId: "GROUPan_dm_direct",
        directConversationId: "direct-1",
        imGroupId: "an_dm_direct",
        targetId: "an_dm_direct",
      },
      clientRequestId: "request-direct-1",
      mentions: [],
      quote: {
        messageId: "message-0",
        preview: "前一条",
        senderId: "agent-im-1",
        senderName: "研究助手",
      },
      text: "私信收到",
    });

    expect(createTextMessage).toHaveBeenCalledWith({
      cloudCustomData: JSON.stringify({
        clientRequestId: "request-direct-1",
        quote: {
          messageId: "message-0",
          preview: "前一条",
          senderId: "agent-im-1",
          senderName: "研究助手",
        },
        schema: "vela.client-message/v2",
      }),
      conversationType: "GROUP",
      needReadReceipt: true,
      payload: {text: "私信收到"},
      to: "an_dm_direct",
    });
  });

  it("rejects group-only Task messages in a direct conversation", async () => {
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createCustomMessage: jest.fn(),
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        sendMessage: jest.fn(),
      },
    });

    await expect(
      service.sendTask({
        channel: {
          conversationId: "GROUPan_dm_direct",
          directConversationId: "direct-1",
          imGroupId: "an_dm_direct",
          targetId: "an_dm_direct",
        },
        clientRequestId: "request-task-direct",
        task: {
          status: "todo",
          taskId: "task-1",
          title: "不应发送",
        },
      }),
    ).rejects.toThrow("私信不支持 Task 消息");
  });

  it("sends a Thread reply with stable relation metadata and message reference", async () => {
    const confirmed = textMessage({
      ID: "thread-reply-1",
      flow: "out",
      from: "human-1",
      payload: {text: "在线程里继续"},
      sequence: 108,
      time: 1_785_400_108,
    });
    const createTextMessage = jest.fn(() => confirmed);
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage,
        getMessageList: jest.fn(),
        sendMessage: jest.fn(async () => ({
          data: {message: confirmed},
        })),
      },
    });

    const sent = await service.sendText({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "thread-request-1",
      mentions: [],
      text: "在线程里继续",
      thread: {
        rootMessageRef: {
          groupId: "community-1",
          kind: "group",
          messageId: "root-1",
          sequence: 100,
          timestamp: 1_785_400_000,
          topicId: "topic-1",
        },
        threadId: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
      },
    });

    expect(createTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudCustomData: JSON.stringify({
          clientRequestId: "thread-request-1",
          schema: "vela.thread-reply/v1",
          thread: {
            role: "reply",
            rootMessageRef: {
              groupId: "community-1",
              kind: "group",
              messageId: "root-1",
              sequence: 100,
              timestamp: 1_785_400_000,
              topicId: "topic-1",
            },
            threadId: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
          },
        }),
      }),
    );
    expect(sent).toMatchObject({
      reference: {
        kind: "group",
        messageId: "thread-reply-1",
        sequence: 108,
        senderUserId: "human-1",
        timestamp: 1_785_400_108,
      },
      thread: {
        role: "reply",
        threadId: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
      },
    });
  });

  it("hydrates indexed Thread references with Tencent sequence hopping", async () => {
    const reply = textMessage({
      ID: "old-thread-reply-1",
      payload: {text: "很早以前的回复"},
      sequence: 88,
    });
    const getMessageListHopping = jest.fn(async () => ({
      data: {
        isCompleted: true,
        messageList: [reply],
      },
    }));
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        getMessageListHopping,
        sendMessage: jest.fn(),
      },
    });

    const messages = await service.loadMessagesByReferences(
      {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      [
        {
          groupId: "community-1",
          kind: "group",
          messageId: "old-thread-reply-1",
          sequence: 88,
          timestamp: 1_785_400_000,
          topicId: "topic-1",
        },
      ],
    );

    expect(getMessageListHopping).toHaveBeenCalledWith({
      conversationID: "GROUPtopic-1",
      count: 1,
      direction: 0,
      sequence: 88,
    });
    expect(messages).toEqual([
      expect.objectContaining({
        id: "old-thread-reply-1",
        text: "很早以前的回复",
      }),
    ]);
  });

  it("hydrates every reference when a platform Thread page exceeds fifteen items", async () => {
    const getMessageListHopping = jest.fn(async (input) => ({
      data: {
        isCompleted: true,
        messageList: [
          textMessage({
            ID: `thread-reply-${input.sequence}`,
            payload: {text: `回复 ${input.sequence}`},
            sequence: input.sequence,
          }),
        ],
      },
    }));
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        getMessageListHopping,
        sendMessage: jest.fn(),
      },
    });
    const references = Array.from({length: 20}, (_, index) => ({
      kind: "group" as const,
      messageId: `thread-reply-${index + 1}`,
      sequence: index + 1,
      timestamp: 1_785_400_000 + index,
    }));

    const messages = await service.loadMessagesByReferences(
      {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      references,
    );

    expect(messages).toHaveLength(20);
    expect(getMessageListHopping).toHaveBeenCalledTimes(20);
  });

  it("loads the surrounding group context on both sides of a search result sequence", async () => {
    const target = textMessage({
      ID: "search-target",
      payload: {text: "目标消息"},
      sequence: 50,
      time: 1_785_400_050,
    });
    const getMessageListHopping = jest.fn(async (input) => ({
      data: {
        isCompleted: true,
        messageList:
          input.direction === 0
            ? [
                textMessage({ID: "before", sequence: 49, time: 1_785_400_049}),
                target,
              ]
            : [
                target,
                textMessage({ID: "after", sequence: 51, time: 1_785_400_051}),
              ],
      },
    }));
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        getMessageListHopping,
        sendMessage: jest.fn(),
      },
    });

    const messages = await service.loadMessageContext(
      {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      {
        kind: "group",
        messageId: "search-target",
        sequence: 50,
        timestamp: 1_785_400_050,
      },
    );

    expect(getMessageListHopping).toHaveBeenNthCalledWith(1, {
      conversationID: "GROUPtopic-1",
      count: 15,
      direction: 0,
      sequence: 50,
    });
    expect(getMessageListHopping).toHaveBeenNthCalledWith(2, {
      conversationID: "GROUPtopic-1",
      count: 15,
      direction: 1,
      sequence: 50,
    });
    expect(messages.map((message) => message.id)).toEqual([
      "before",
      "search-target",
      "after",
    ]);
  });

  it("loads the surrounding Server 内私信 group context by timestamp", async () => {
    const target = textMessage({
      ID: "direct-target",
      conversationID: "GROUPan_dm_direct",
      time: 1_785_400_050,
    });
    const getMessageListHopping = jest.fn(async () => ({
      data: {isCompleted: true, messageList: [target]},
    }));
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        getMessageListHopping,
        sendMessage: jest.fn(),
      },
    });

    await service.loadMessageContext(
      {
        conversationId: "GROUPan_dm_direct",
        directConversationId: "direct-1",
        imGroupId: "an_dm_direct",
        targetId: "an_dm_direct",
      },
      {
        groupId: "an_dm_direct",
        kind: "group",
        messageId: "direct-target",
        timestamp: 1_785_400_050,
      },
    );

    expect(getMessageListHopping).toHaveBeenNthCalledWith(1, {
      conversationID: "GROUPan_dm_direct",
      count: 15,
      direction: 0,
      time: 1_785_400_050,
    });
    expect(getMessageListHopping).toHaveBeenNthCalledWith(2, {
      conversationID: "GROUPan_dm_direct",
      count: 15,
      direction: 1,
      time: 1_785_400_050,
    });
  });

  it("creates image and file messages with cross-platform sources and upload progress", async () => {
    const imageDraft = textMessage({
      ID: "local-image-1",
      flow: "out",
      payload: {
        imageInfoArray: [],
      },
      status: "unSend",
      type: "TIMImageElem",
    });
    const fileDraft = textMessage({
      ID: "local-file-1",
      flow: "out",
      payload: {
        fileName: "design.pdf",
      },
      status: "unSend",
      type: "TIMFileElem",
    });
    const createImageMessage = jest.fn(
      (_options: Record<string, unknown>) => imageDraft,
    );
    const createFileMessage = jest.fn(
      (_options: Record<string, unknown>) => fileDraft,
    );
    const sendMessage = jest.fn(async (draft: SdkMessage) => ({
      data: {
        message: {
          ...draft,
          ID: draft.ID.replace("local-", "remote-"),
          ...(draft.type === "TIMImageElem"
            ? {
                payload: {
                  imageInfoArray: [
                    {
                      height: 480,
                      imageType: 0,
                      size: 456_789,
                      url: "https://example.invalid/diagram.png",
                      width: 640,
                    },
                  ],
                },
              }
            : {}),
          status: "success",
        },
      },
    }));
    const sdk = {
      createFileMessage,
      createImageMessage,
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(),
      getMessageList: jest.fn(),
      sendMessage,
    };
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk,
    });
    const progress: number[] = [];

    const imagePromise = service.sendAttachment({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "request-image-1",
      kind: "image",
      onProgress: (value) => progress.push(value),
      source: {
        kind: "uri",
        mimeType: "image/png",
        name: "diagram.png",
        size: 456_789,
        uri: "file:///private/diagram.png",
      },
    });
    const imageOptions = createImageMessage.mock.calls[0]?.[0];
    if (typeof imageOptions?.onProgress === "function") {
      imageOptions.onProgress(25);
    }
    const image = await imagePromise;

    const platformFile = { name: "design.pdf", size: 1_024 };
    const file = await service.sendAttachment({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "request-file-1",
      kind: "file",
      onProgress: (value) => progress.push(value),
      source: {
        file: platformFile,
        kind: "platform-file",
        mimeType: "application/pdf",
        name: "design.pdf",
        size: 1_024,
      },
    });

    expect(createImageMessage).toHaveBeenCalledWith({
      cloudCustomData: JSON.stringify({
        clientRequestId: "request-image-1",
        schema: "vela.client-message/v2",
      }),
      conversationType: "GROUP",
      onProgress: expect.any(Function),
      payload: {
        file: {
          name: "diagram.png",
          size: 456_789,
          type: "image/png",
          uri: "file:///private/diagram.png",
        },
      },
      to: "topic-1",
    });
    expect(createFileMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { file: platformFile },
      }),
    );
    expect(progress).toEqual([0.25]);
    expect(image).toMatchObject({
      delivery: { state: "sent" },
      id: "remote-image-1",
      kind: "image",
    });
    expect(file).toMatchObject({
      delivery: { state: "sent" },
      id: "remote-file-1",
      kind: "file",
    });
  });

  it("reconciles an uploaded image before exposing it as sent", async () => {
    const metadata = JSON.stringify({
      clientRequestId: "request-image-ack",
      schema: "vela.client-message/v2",
    });
    let reportProgress: ((value: unknown) => void) | undefined;
    const draft = textMessage({
      cloudCustomData: metadata,
      flow: "out",
      ID: "local-image-ack",
      payload: {imageInfoArray: []},
      status: "unSend",
      type: "TIMImageElem",
    });
    const confirmed = textMessage({
      cloudCustomData: metadata,
      flow: "out",
      ID: "remote-image-ack",
      payload: {
        imageInfoArray: [
          {
            height: 480,
            imageType: 0,
            size: 8_192,
            url: "https://example.invalid/image.jpg",
            width: 640,
          },
        ],
      },
      status: "success",
      type: "TIMImageElem",
    });
    const service = new ChannelChatService({
      attachmentAckTimeoutMs: 0,
      conversationGroup: "GROUP",
      sdk: {
        createImageMessage: jest.fn((options) => {
          reportProgress = options.onProgress as (value: unknown) => void;
          return draft;
        }),
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(async () => ({
          data: {isCompleted: true, messageList: [confirmed]},
        })),
        sendMessage: jest.fn(async () => ({
          data: {...draft, status: "success"},
        })),
      },
      wait: async () => undefined,
    });

    const sending = service.sendAttachment({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "request-image-ack",
      kind: "image",
      source: {kind: "uri", name: "image.jpg", uri: "file:///image.jpg"},
    });
    reportProgress?.(100);

    await expect(sending).resolves.toMatchObject({
      content: {url: "https://example.invalid/image.jpg"},
      delivery: {state: "sent"},
      id: "remote-image-ack",
    });
  });

  it("retries the original Tencent draft by clientRequestId", async () => {
    const draft = textMessage({
      ID: "local-message-1",
      flow: "out",
      from: "human-1",
      payload: { text: "重试这条消息" },
      status: "fail",
    });
    const confirmed = {
      ...draft,
      ID: "remote-message-1",
      status: "success",
    };
    const resendMessage = jest.fn(async () => ({
      data: { message: confirmed },
    }));
    const sdk = {
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(() => draft),
      getMessageList: jest.fn(),
      resendMessage,
      sendMessage: jest.fn(async () => {
        throw new Error("网络暂时不可用");
      }),
    };
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk,
    });
    const input = {
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "request-retry-1",
      mentions: [],
      text: "重试这条消息",
    };

    await expect(service.sendText(input)).rejects.toThrow(
      "网络暂时不可用",
    );
    const retried = await service.retryMessage("request-retry-1");

    expect(resendMessage).toHaveBeenCalledWith(draft);
    expect(retried).toMatchObject({
      clientRequestId: "request-retry-1",
      delivery: { state: "sent" },
      id: "remote-message-1",
    });
  });

  it("marks a Topic conversation read without unsupported group read receipts", async () => {
    const setMessageRead = jest.fn(async () => ({ data: {} }));
    const sendMessageReadReceipt = jest.fn(async () => ({ data: {} }));
    const sdk = {
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(),
      getMessageList: jest.fn(),
      sendMessage: jest.fn(),
      sendMessageReadReceipt,
      setMessageRead,
    };
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk,
    });
    const receiptMessage = textMessage({
      ID: "receipt-message-1",
      conversationID: "GROUPtopic-1",
      flow: "in",
      needReadReceipt: true,
    });
    service.normalizeMessages([receiptMessage]);

    await service.markRead({
      channelId: "channel-1",
      conversationId: "GROUPtopic-1",
      imGroupId: "community-1",
      imTopicId: "topic-1",
      targetId: "topic-1",
    });
    await service.markRead({
      channelId: "channel-1",
      conversationId: "GROUPtopic-1",
      imGroupId: "community-1",
      imTopicId: "topic-1",
      targetId: "topic-1",
    });

    expect(setMessageRead).toHaveBeenCalledWith({
      conversationID: "GROUPtopic-1",
    });
    expect(sendMessageReadReceipt).not.toHaveBeenCalled();
  });

  it("acknowledges receipt-requesting messages for a supported ordinary group", async () => {
    const setMessageRead = jest.fn(async () => ({ data: {} }));
    const sendMessageReadReceipt = jest.fn(async () => ({ data: {} }));
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        sendMessage: jest.fn(),
        sendMessageReadReceipt,
        setMessageRead,
      },
    });
    const receiptMessage = textMessage({
      ID: "receipt-message-1",
      conversationID: "GROUPordinary-1",
      flow: "in",
      needReadReceipt: true,
    });
    service.normalizeMessages([receiptMessage]);

    await service.markRead({
      channelId: "channel-1",
      conversationId: "GROUPordinary-1",
      imGroupId: "ordinary-1",
      imTopicId: null,
      targetId: "ordinary-1",
    });

    expect(sendMessageReadReceipt).toHaveBeenCalledWith([
      receiptMessage,
    ]);
  });

  it("sends a Task projection as a Tencent custom message", async () => {
    const draft = textMessage({
      ID: "local-task-1",
      flow: "out",
      payload: {
        data: JSON.stringify({
          sourceMessageRef: {
            groupId: "community-1",
            kind: "group",
            messageId: "source-1",
            topicId: "topic-1",
          },
          status: "todo",
          taskId: "task-1",
          title: "核对腾讯消息协议",
        }),
        description: "Task",
        extension: "vela.task-message/v1",
      },
      status: "unSend",
      type: "TIMCustomElem",
    });
    const createCustomMessage = jest.fn(
      (_options: Record<string, unknown>) => draft,
    );
    const sdk = {
      createCustomMessage,
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(),
      getMessageList: jest.fn(),
      sendMessage: jest.fn(async () => ({
        data: {
          message: {
            ...draft,
            ID: "remote-task-1",
            status: "success",
          },
        },
      })),
    };
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk,
    });

    const sent = await service.sendTask({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "request-task-1",
      task: {
        sourceMessageRef: {
          groupId: "community-1",
          kind: "group",
          messageId: "source-1",
          topicId: "topic-1",
        },
        status: "todo",
        taskId: "task-1",
        title: "核对腾讯消息协议",
      },
    });

    expect(createCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudCustomData: expect.stringContaining(
          '"schema":"vela.task-message/v1"',
        ),
        payload: {
          data: expect.stringContaining('"taskId":"task-1"'),
          description: "Task",
          extension: "vela.task-message/v1",
        },
      }),
    );
    expect(sent).toMatchObject({
      content: {
        kind: "task",
        sourceMessageRef: {
          messageId: "source-1",
        },
        taskId: "task-1",
      },
      id: "remote-task-1",
      kind: "task",
    });
  });

  it("delegates Reaction mutations to the raw Tencent message", async () => {
    const addMessageReaction = jest.fn(async () => ({ data: {} }));
    const removeMessageReaction = jest.fn(async () => ({ data: {} }));
    const sdk = {
      addMessageReaction,
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(),
      getMessageList: jest.fn(),
      removeMessageReaction,
      sendMessage: jest.fn(),
    };
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk,
    });
    const raw = textMessage({ ID: "reaction-message-1" });
    service.normalizeMessages([raw]);

    await service.setReaction("reaction-message-1", "👍", true);
    await service.setReaction("reaction-message-1", "👍", false);

    expect(addMessageReaction).toHaveBeenCalledWith(raw, "👍");
    expect(removeMessageReaction).toHaveBeenCalledWith(raw, "👍");
  });

  it("revokes a loaded Tencent message and returns the revoked projection", async () => {
    const raw = textMessage({ID: "revoke-message-1", flow: "out"});
    const revokeMessage = jest.fn(async () => ({
      data: {message: {...raw, isRevoked: true}},
    }));
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        revokeMessage,
        sendMessage: jest.fn(),
      },
    });
    service.normalizeMessages([raw]);

    const recalled = await service.revokeMessage(raw.ID);

    expect(revokeMessage).toHaveBeenCalledWith(raw);
    expect(recalled).toMatchObject({
      id: raw.ID,
      kind: "system",
      rawType: "TIMRevokedElem",
      text: "[消息已撤回]",
    });
  });

  it("maps Tencent cloud searchResultList and cursor for supported conversations", async () => {
    const searchCloudMessages = jest.fn(async () => ({
      data: {
        cursor: "search-cursor-2",
        searchResultList: [
          {
            conversationID: "GROUPgroup-1",
            messageCount: 12,
            messageList: [textMessage({
              ID: "search-1",
              conversationID: "GROUPgroup-1",
            })],
          },
        ],
        totalCount: 12,
      },
    }));
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        searchCloudMessages,
        sendMessage: jest.fn(),
      },
    });

    const page = await service.searchMessages({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPgroup-1",
        imGroupId: "group-1",
        imTopicId: null,
        targetId: "group-1",
      },
      cursor: "search-cursor-1",
      limit: 20,
      query: "协议",
    });

    expect(searchCloudMessages).toHaveBeenCalledWith({
      conversationID: "GROUPgroup-1",
      count: 20,
      cursor: "search-cursor-1",
      keywordList: ["协议"],
      keywordListMatchType: "and",
    });
    expect(page).toMatchObject({
      completed: false,
      messages: [expect.objectContaining({ id: "search-1" })],
      nextCursor: "search-cursor-2",
      totalCount: 12,
    });
  });

  it("scans Tencent roaming history for Topic search because cloud search does not support Topic", async () => {
    const getMessageList = jest.fn(async () => ({
      data: {
        isCompleted: false,
        messageList: [
          textMessage({
            ID: "topic-match-1",
            payload: { text: "腾讯协议已确认" },
          }),
          textMessage({
            ID: "topic-other-1",
            payload: { text: "普通讨论" },
          }),
        ],
        nextReqMessageID: "topic-search-cursor-2",
      },
    }));
    const searchCloudMessages = jest.fn();
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList,
        searchCloudMessages,
        sendMessage: jest.fn(),
      },
    });

    const page = await service.searchMessages({
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      cursor: "topic-search-cursor-1",
      limit: 20,
      query: "协议",
    });

    expect(searchCloudMessages).not.toHaveBeenCalled();
    expect(getMessageList).toHaveBeenCalledWith({
      conversationID: "GROUPtopic-1",
      nextReqMessageID: "topic-search-cursor-1",
    });
    expect(page).toEqual({
      completed: false,
      messages: [expect.objectContaining({ id: "topic-match-1" })],
      nextCursor: "topic-search-cursor-2",
      totalCount: 1,
    });
  });

  it("keeps only live messages for the visible Channel", () => {
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      messageText: "TIMTextElem",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        sendMessage: jest.fn(),
      },
    });

    const messages = service.normalizeIncoming(
      {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      [
        textMessage({ ID: "visible", conversationID: "GROUPtopic-1" }),
        textMessage({ ID: "other", conversationID: "GROUPtopic-2" }),
      ],
    );

    expect(messages.map((message) => message.id)).toEqual(["visible"]);
  });

  it("normalizes raw live messages without inventing a second message model", () => {
    const service = new ChannelChatService({
      conversationGroup: "GROUP",
      messageText: "TIMTextElem",
      sdk: {
        createTextAtMessage: jest.fn(),
        createTextMessage: jest.fn(),
        getMessageList: jest.fn(),
        sendMessage: jest.fn(),
      },
    });

    expect(
      service.normalizeMessages([
        textMessage({ ID: "live-1", conversationID: "GROUPtopic-1" }),
      ]),
    ).toEqual([
      expect.objectContaining({
        conversationId: "GROUPtopic-1",
        id: "live-1",
        mentions: [],
      }),
    ]);
  });
});
