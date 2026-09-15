import assert from "node:assert/strict";
import test from "node:test";

import type {ConversationAddress} from "./conversation.js";
import {
  composerDocumentHasContent,
  composerDocumentMentions,
  composerDocumentPreview,
  composerDocumentText,
  createComposerDocument,
  createComposerTextDocument,
  planComposerSubmission,
  readComposerMentionTrigger,
  replaceComposerDocumentRangeWithMention,
  type ComposerAttachmentDraft,
  type ComposerDraft,
} from "./composer.js";

const channel: ConversationAddress = {
  channelId: "channel-1",
  conversationId: "GROUPtopic-1",
  imGroupId: "group-1",
  imTopicId: "topic-1",
  targetId: "topic-1",
};

const mention = {
  displayName: "研究助手",
  handle: "researcher",
  imUserId: "agent_im_1",
  memberId: "member-agent-1",
  memberKind: "agent" as const,
  type: "mention" as const,
};

function attachment(id: string, name: string): ComposerAttachmentDraft {
  return {
    id,
    kind: "file",
    name,
    size: 1_024,
    source: {
      kind: "uri",
      name,
      size: 1_024,
      uri: `file:///${name}`,
    },
  };
}

test("composer document normalizes text while preserving structured mentions", () => {
  const document = createComposerDocument([
    {type: "text", text: "请 "},
    {type: "text", text: "帮忙 "},
    mention,
    {type: "text", text: ""},
    {type: "text", text: " 总结"},
  ]);

  assert.deepEqual(document, {
    nodes: [
      {type: "text", text: "请 帮忙 "},
      mention,
      {type: "text", text: " 总结"},
    ],
    version: 1,
  });
  assert.equal(composerDocumentText(document), "请 帮忙 @研究助手 总结");
  assert.equal(composerDocumentPreview(document), "请 帮忙 @研究助手 总结");
});

test("composer mentions deduplicate send identities without rewriting text", () => {
  const document = createComposerDocument([
    mention,
    {type: "text", text: " 和 "},
    {...mention, displayName: "研究助手新名称"},
  ]);

  assert.equal(composerDocumentText(document), "@研究助手 和 @研究助手新名称");
  assert.deepEqual(composerDocumentMentions(document), [
    {
      displayName: "研究助手",
      imUserId: "agent_im_1",
      memberId: "member-agent-1",
      memberKind: "agent",
    },
  ]);
});

test("visible content accepts a mention but rejects whitespace and zero-width text", () => {
  assert.equal(composerDocumentHasContent(createComposerTextDocument(" \n\t​")), false);
  assert.equal(composerDocumentHasContent(createComposerDocument([mention])), true);
});

test("mention trigger reads the active at-query at a collapsed cursor", () => {
  assert.deepEqual(
    readComposerMentionTrigger("请 @rese", {start: 7, end: 7}),
    {end: 7, query: "rese", start: 2},
  );
  assert.equal(
    readComposerMentionTrigger("邮箱 user@example.com", {start: 19, end: 19}),
    null,
  );
  assert.equal(
    readComposerMentionTrigger("选中文字", {start: 0, end: 2}),
    null,
  );
});

test("mention trigger still reads an at-query while IME composition spans the query", () => {
  // Chinese IMEs commonly leave a non-collapsed selection over the composing
  // characters. Mentions must key off the caret end, not require collapse.
  assert.deepEqual(
    readComposerMentionTrigger("请 @ni", {start: 3, end: 5}),
    {end: 5, query: "ni", start: 2},
  );
});

test("mention replacement preserves surrounding text and inserts one trailing space", () => {
  const result = replaceComposerDocumentRangeWithMention({
    document: createComposerTextDocument("请 @rese处理"),
    end: 7,
    mention,
    start: 2,
  });

  assert.equal(composerDocumentText(result.document), "请 @研究助手 处理");
  assert.equal(result.cursor, 8);
  assert.deepEqual(result.document.nodes, [
    {text: "请 ", type: "text"},
    mention,
    {text: " 处理", type: "text"},
  ]);
});

test("submission planner sends attachments first and mention text as final commit", () => {
  const quote = {
    messageId: "message-1",
    preview: "先看这个",
    senderId: "human-1",
    senderName: "小林",
  };
  const draft: ComposerDraft = {
    attachments: [attachment("attachment-1", "a.pdf"), attachment("attachment-2", "b.pdf")],
    document: createComposerDocument([
      {type: "text", text: "请 "},
      mention,
      {type: "text", text: " 处理"},
    ]),
    quote,
  };

  const submission = planComposerSubmission({
    channel,
    clientRequestIds: [
      "019fce00-0000-7000-8000-000000000002",
      "019fce00-0000-7000-8000-000000000003",
      "019fce00-0000-7000-8000-000000000004",
    ],
    conversationKey: "channel:channel-1",
    draft,
    submissionId: "019fce00-0000-7000-8000-000000000001",
  });

  assert.deepEqual(
    submission.parts.map((part) => ({
      clientRequestId: part.clientRequestId,
      final: part.submission.final,
      index: part.submission.index,
      quote: part.quote,
      role: part.role,
      status: part.status,
    })),
    [
      {
        clientRequestId: "019fce00-0000-7000-8000-000000000002",
        final: false,
        index: 0,
        quote: undefined,
        role: "attachment",
        status: "queued",
      },
      {
        clientRequestId: "019fce00-0000-7000-8000-000000000003",
        final: false,
        index: 1,
        quote: undefined,
        role: "attachment",
        status: "queued",
      },
      {
        clientRequestId: "019fce00-0000-7000-8000-000000000004",
        final: true,
        index: 2,
        quote,
        role: "commit",
        status: "queued",
      },
    ],
  );
  assert.equal(submission.phase, "queued");
  assert.equal(submission.parts[2]?.submission.count, 3);
});

test("attachment-only submission binds quote to the first part and final to the last", () => {
  const quote = {
    messageId: "message-1",
    preview: "图片原文",
    senderId: "human-1",
    senderName: "小林",
  };
  const submission = planComposerSubmission({
    channel,
    clientRequestIds: [
      "019fce00-0000-7000-8000-000000000012",
      "019fce00-0000-7000-8000-000000000013",
    ],
    conversationKey: "channel:channel-1",
    draft: {
      attachments: [attachment("attachment-1", "a.pdf"), attachment("attachment-2", "b.pdf")],
      document: createComposerDocument(),
      quote,
    },
    submissionId: "019fce00-0000-7000-8000-000000000011",
  });

  assert.equal(submission.parts.length, 2);
  assert.deepEqual(submission.parts[0]?.quote, quote);
  assert.equal(submission.parts[0]?.submission.final, false);
  assert.equal(submission.parts[1]?.submission.final, true);
});

test("submission planner rejects empty input, invalid ids and excessive attachments", () => {
  const empty: ComposerDraft = {
    attachments: [],
    document: createComposerTextDocument(" \n​"),
  };
  assert.throws(
    () =>
      planComposerSubmission({
        channel,
        clientRequestIds: [],
        conversationKey: "channel:channel-1",
        draft: empty,
        submissionId: "019fce00-0000-7000-8000-000000000021",
      }),
    /empty/i,
  );

  assert.throws(
    () =>
      planComposerSubmission({
        channel,
        clientRequestIds: ["not-a-uuid"],
        conversationKey: "channel:channel-1",
        draft: {attachments: [], document: createComposerTextDocument("hello")},
        submissionId: "not-a-uuid",
      }),
    /UUIDv7/,
  );

  assert.throws(
    () =>
      planComposerSubmission({
        channel,
        clientRequestIds: Array.from({length: 10}, (_, index) =>
          `019fce00-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
        conversationKey: "channel:channel-1",
        draft: {
          attachments: Array.from({length: 10}, (_, index) =>
            attachment(`attachment-${index}`, `${index}.pdf`),
          ),
          document: createComposerDocument(),
        },
        submissionId: "019fce00-0000-7000-8000-000000000031",
      }),
    /9 attachments/,
  );
});
