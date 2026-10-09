import {
  MessagingSendError,
  createComposerDocument,
  planComposerSubmission,
  type ComposerSubmission,
  type Message,
  type MessagingPort,
} from "@vela/client-core";

import {SubmissionCoordinator} from "./submission-coordinator";

function sentMessage(clientRequestId: string): Message {
  return {
    clientRequestId,
    content: {kind: "text", text: "sent"},
    conversationId: "GROUPtopic-1",
    createdAt: "2026-08-05T00:00:00.000Z",
    delivery: {state: "sent"},
    direction: "outgoing",
    id: `remote:${clientRequestId}`,
    kind: "text",
    mentions: [],
    rawType: "TIMTextElem",
    reactions: [],
    read: {state: "unknown"},
    senderId: "human-1",
    senderName: "Skip",
    text: "sent",
  };
}

function submission(prefix: string): ComposerSubmission {
  return planComposerSubmission({
    channel: {
      channelId: "channel-1",
      conversationId: "GROUPtopic-1",
      imGroupId: "group-1",
      imTopicId: "topic-1",
      targetId: "topic-1",
    },
    clientRequestIds: [
      `${prefix}-0000-7000-8000-000000000002`,
      `${prefix}-0000-7000-8000-000000000003`,
    ],
    conversationKey: "channel:channel-1",
    draft: {
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "spec.pdf",
          source: {
            kind: "uri",
            name: "spec.pdf",
            uri: "file:///spec.pdf",
          },
        },
      ],
      document: createComposerDocument([{text: "请处理", type: "text"}]),
    },
    submissionId: `${prefix}-0000-7000-8000-000000000001`,
  });
}

function messaging(overrides: Partial<MessagingPort> = {}): MessagingPort {
  return {
    close: jest.fn(),
    connect: jest.fn(),
    listConversations: jest.fn(),
    loadHistory: jest.fn(),
    loadMessageContext: jest.fn(),
    loadMessagesByReferences: jest.fn(),
    markRead: jest.fn(),
    reconcileMessage: jest.fn(async () => ({state: "pending" as const})),
    retryMessage: jest.fn(async (id) => sentMessage(id)),
    revokeMessage: jest.fn(),
    searchMessages: jest.fn(),
    sendAttachment: jest.fn(async (input) => sentMessage(input.clientRequestId)),
    sendTask: jest.fn(),
    sendText: jest.fn(async (input) => sentMessage(input.clientRequestId)),
    setReaction: jest.fn(),
    setScope: jest.fn(),
    subscribeConversations: jest.fn(() => () => undefined),
    subscribeLifecycle: jest.fn(() => () => undefined),
    subscribeMessages: jest.fn(() => () => undefined),
    waitUntilReady: jest.fn(),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SubmissionCoordinator", () => {
  it("sends attachments before the final text and commits the submission", async () => {
    const calls: string[] = [];
    const port = messaging({
      sendAttachment: jest.fn(async (input) => {
        calls.push(`attachment:${input.clientRequestId}`);
        return sentMessage(input.clientRequestId);
      }),
      sendText: jest.fn(async (input) => {
        calls.push(`commit:${input.clientRequestId}`);
        return sentMessage(input.clientRequestId);
      }),
    });
    const states: ComposerSubmission[] = [];
    const coordinator = new SubmissionCoordinator({
      messaging: port,
      onChange: (value) => states.push(value),
    });

    coordinator.enqueue(submission("019fce00"));
    await coordinator.whenIdle("channel:channel-1");

    expect(calls).toEqual([
      "attachment:019fce00-0000-7000-8000-000000000002",
      "commit:019fce00-0000-7000-8000-000000000003",
    ]);
    expect(states.at(-1)?.phase).toBe("committed");
  });

  it("publishes attachment progress and the confirmed message projection", async () => {
    const value = submission("019fce06");
    const confirmed = sentMessage(value.parts[0]?.clientRequestId ?? "missing");
    const messages: Message[] = [];
    const progress: Array<{clientRequestId: string; progress: number}> = [];
    const port = messaging({
      sendAttachment: jest.fn(async (input) => {
        input.onProgress?.(0.45);
        return confirmed;
      }),
    });
    const coordinator = new SubmissionCoordinator({
      messaging: port,
      onMessage: (message: Message) => messages.push(message),
      onProgress: (clientRequestId: string, value: number) =>
        progress.push({clientRequestId, progress: value}),
    });

    coordinator.enqueue(value);
    await coordinator.whenIdle("channel:channel-1");

    expect(progress).toEqual([
      {
        clientRequestId: value.parts[0]?.clientRequestId,
        progress: 0.45,
      },
    ]);
    expect(messages).toContainEqual({
      ...confirmed,
      submission: value.parts[0]?.submission,
    });
  });

  it("blocks the same conversation after an attachment failure and resumes by SDK retry", async () => {
    const first = submission("019fce01");
    const second = submission("019fce02");
    const sendAttachment = jest
      .fn()
      .mockRejectedValueOnce(
        new MessagingSendError("upload failed", {
          outcome: "definitive",
          retryable: true,
        }),
      )
      .mockImplementation(async (input) => sentMessage(input.clientRequestId));
    const sendText = jest.fn(async (input) => sentMessage(input.clientRequestId));
    const retryMessage = jest.fn(async (id) => sentMessage(id));
    const coordinator = new SubmissionCoordinator({
      messaging: messaging({retryMessage, sendAttachment, sendText}),
    });

    coordinator.enqueue(first);
    coordinator.enqueue(second);
    await flush();

    expect(coordinator.get(first.id)?.phase).toBe("blocked");
    expect(coordinator.get(second.id)?.phase).toBe("queued");
    expect(sendText).not.toHaveBeenCalled();

    await coordinator.retry(first.id);
    await coordinator.whenIdle("channel:channel-1");

    expect(retryMessage).toHaveBeenCalledWith(first.parts[0]?.clientRequestId);
    expect(coordinator.get(first.id)?.phase).toBe("committed");
    expect(coordinator.get(second.id)?.phase).toBe("committed");
  });

  it("reconciles uncertain delivery and never blindly recreates the message", async () => {
    const value = submission("019fce03");
    const sendAttachment = jest.fn(async () => {
      throw new Error("socket closed");
    });
    const reconcileMessage = jest.fn(async (input) => ({
      message: sentMessage(input.clientRequestId),
      state: "sent" as const,
    }));
    const sendText = jest.fn(async (input) => sentMessage(input.clientRequestId));
    const coordinator = new SubmissionCoordinator({
      messaging: messaging({reconcileMessage, sendAttachment, sendText}),
    });

    coordinator.enqueue(value);
    await coordinator.whenIdle("channel:channel-1");

    expect(sendAttachment).toHaveBeenCalledTimes(1);
    expect(reconcileMessage).toHaveBeenCalledWith({
      channel: value.channel,
      clientRequestId: value.parts[0]?.clientRequestId,
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(coordinator.get(value.id)?.phase).toBe("committed");
  });

  it("cancels a blocked submission and advances the next queued submission", async () => {
    const first = submission("019fce04");
    const second = submission("019fce05");
    const sendAttachment = jest
      .fn()
      .mockRejectedValueOnce(
        new MessagingSendError("unreadable", {
          outcome: "definitive",
          retryable: false,
        }),
      )
      .mockImplementation(async (input) => sentMessage(input.clientRequestId));
    const coordinator = new SubmissionCoordinator({
      messaging: messaging({sendAttachment}),
    });

    coordinator.enqueue(first);
    coordinator.enqueue(second);
    await flush();
    expect(coordinator.canRetry(first.id)).toBe(false);

    coordinator.cancel(first.id);
    await coordinator.whenIdle("channel:channel-1");

    expect(coordinator.get(first.id)?.phase).toBe("cancelled");
    expect(coordinator.get(second.id)?.phase).toBe("committed");
  });
});
