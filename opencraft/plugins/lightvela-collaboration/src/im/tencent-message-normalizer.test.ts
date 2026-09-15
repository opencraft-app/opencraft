import "./test-compat";

import {
  normalizeTencentMessage,
  type SdkMessage,
  type TencentMessageTypes,
} from "./tencent-message-normalizer";

const types: TencentMessageTypes = {
  audio: "TIMSoundElem",
  custom: "TIMCustomElem",
  file: "TIMFileElem",
  image: "TIMImageElem",
  merged: "TIMRelayElem",
  text: "TIMTextElem",
  video: "TIMVideoFileElem",
};

function rawMessage(overrides: Partial<SdkMessage> = {}): SdkMessage {
  return {
    ID: "message-1",
    atUserList: [],
    avatar: "https://example.invalid/avatar.png",
    cloudCustomData: "",
    conversationID: "GROUPtopic-1",
    flow: "in",
    from: "agent-1",
    isPeerRead: false,
    nameCard: "研究助手",
    nick: "Agent",
    payload: { text: "收到，我来处理。" },
    status: "success",
    time: 1_785_400_000,
    type: "TIMTextElem",
    ...overrides,
  };
}

describe("normalizeTencentMessage", () => {
  it("normalizes a text message into the shared envelope", () => {
    expect(normalizeTencentMessage(rawMessage(), types)).toEqual({
      clientRequestId: undefined,
      content: {
        kind: "text",
        text: "收到，我来处理。",
      },
      conversationId: "GROUPtopic-1",
      createdAt: new Date(1_785_400_000_000).toISOString(),
      delivery: { state: "sent" },
      direction: "incoming",
      id: "message-1",
      kind: "text",
      mentions: [],
      quote: undefined,
      rawType: "TIMTextElem",
      reactions: [],
      read: { state: "unread" },
      senderAvatar: "https://example.invalid/avatar.png",
      senderId: "agent-1",
      senderName: "研究助手",
      text: "收到，我来处理。",
    });
  });

  it("normalizes image and file payloads without losing render metadata", () => {
    const image = normalizeTencentMessage(
      rawMessage({
        ID: "image-1",
        payload: {
          imageInfoArray: [
            {
              height: 1080,
              imageType: 0,
              size: 456_789,
              url: "https://example.invalid/original.png",
              width: 1920,
            },
            {
              height: 180,
              imageType: 3,
              size: 12_345,
              url: "https://example.invalid/thumb.png",
              width: 320,
            },
          ],
        },
        type: "TIMImageElem",
      }),
      types,
    );
    const file = normalizeTencentMessage(
      rawMessage({
        ID: "file-1",
        payload: {
          fileName: "spec.pdf",
          fileSize: 1_048_576,
          fileUrl: "https://example.invalid/spec.pdf",
        },
        type: "TIMFileElem",
      }),
      types,
    );

    expect(image).toMatchObject({
      content: {
        height: 1080,
        kind: "image",
        size: 456_789,
        thumbnailUrl: "https://example.invalid/thumb.png",
        url: "https://example.invalid/original.png",
        width: 1920,
      },
      kind: "image",
      text: "[图片]",
    });
    expect(file).toMatchObject({
      content: {
        kind: "file",
        name: "spec.pdf",
        size: 1_048_576,
        url: "https://example.invalid/spec.pdf",
      },
      kind: "file",
      text: "spec.pdf",
    });
  });

  it("decodes client request, quote and Task metadata from cloudCustomData", () => {
    const message = normalizeTencentMessage(
      rawMessage({
        cloudCustomData: JSON.stringify({
          clientRequestId: "request-1",
          quote: {
            messageId: "root-1",
            preview: "先核对接口。",
            senderId: "human-2",
            senderName: "小林",
          },
          schema: "vela.task-message/v1",
          task: {
            assigneeId: null,
            sourceMessageRef: "root-1",
            status: "open",
            taskId: "task-1",
            title: "核对腾讯消息协议",
          },
        }),
        payload: {
          data: JSON.stringify({
            assigneeId: null,
            sourceMessageRef: "root-1",
            status: "open",
            taskId: "task-1",
            title: "核对腾讯消息协议",
          }),
          description: "Task",
          extension: "vela.task-message/v1",
        },
        type: "TIMCustomElem",
      }),
      types,
    );

    expect(message).toMatchObject({
      clientRequestId: "request-1",
      content: {
        assigneeId: undefined,
        kind: "task",
        sourceMessageRef: "root-1",
        status: "open",
        taskId: "task-1",
        title: "核对腾讯消息协议",
      },
      kind: "task",
      quote: {
        messageId: "root-1",
        preview: "先核对接口。",
        senderId: "human-2",
        senderName: "小林",
      },
    });
  });

  it("decodes a valid composer submission reference and ignores invalid ones", () => {
    const valid = normalizeTencentMessage(
      rawMessage({
        cloudCustomData: JSON.stringify({
          clientRequestId: "request-1",
          schema: "vela.composer-submission/v1",
          submission: {
            count: 2,
            final: true,
            id: "submission-1",
            index: 1,
            role: "commit",
          },
        }),
      }),
      types,
    );
    const invalid = normalizeTencentMessage(
      rawMessage({
        cloudCustomData: JSON.stringify({
          schema: "vela.composer-submission/v1",
          submission: {
            count: 2,
            final: false,
            id: "submission-1",
            index: 1,
            role: "commit",
          },
        }),
      }),
      types,
    );

    expect(valid.submission).toEqual({
      count: 2,
      final: true,
      id: "submission-1",
      index: 1,
      role: "commit",
    });
    expect(invalid.submission).toBeUndefined();
  });

  it("degrades malformed custom data and unknown message types safely", () => {
    const malformed = normalizeTencentMessage(
      rawMessage({
        cloudCustomData: "{not-json",
        payload: { data: "{also-not-json", description: "自定义事件" },
        type: "TIMCustomElem",
      }),
      types,
    );
    const unknown = normalizeTencentMessage(
      rawMessage({
        payload: { secret: "must-not-be-rendered" },
        type: "TIMFutureElem",
      }),
      types,
    );

    expect(malformed).toMatchObject({
      content: {
        description: "自定义事件",
        kind: "custom",
      },
      kind: "custom",
      text: "自定义事件",
    });
    expect(unknown).toMatchObject({
      content: {
        kind: "unsupported",
        rawType: "TIMFutureElem",
      },
      kind: "unsupported",
      text: "[暂不支持的消息]",
    });
  });

  it("decodes a Thread reply relationship without treating it as a quote", () => {
    const message = normalizeTencentMessage(
      rawMessage({
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
              timestamp: 1_785_399_000,
              topicId: "topic-1",
            },
            threadId: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
          },
        }),
        sequence: 108,
      }),
      types,
    );

    expect(message).toMatchObject({
      quote: undefined,
      thread: {
        role: "reply",
        rootMessageRef: {
          messageId: "root-1",
          sequence: 100,
          timestamp: 1_785_399_000,
        },
        threadId: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
      },
    });
  });
});
