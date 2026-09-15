import assert from "node:assert/strict";
import test from "node:test";

import type { HumanImSession } from "@lightvela/vela-chat-client-core";
import { CollaborationMessagingService } from "../plugins/lightvela-collaboration/src/collaboration-messaging-service";
import { CollaborationWorkspaceService } from "../plugins/lightvela-collaboration/src/collaboration-workspace-service";
import { createTencentWebMessagingPort } from "../plugins/lightvela-collaboration/src/im/create-tencent-web-messaging";
import type { TencentChatNamespace } from "../plugins/lightvela-collaboration/src/im/tencent-chat-gateway";

const session: HumanImSession = {
  sdkAppId: 1_400_000_001,
  userId: "u_agent_collaborator",
  userSig: "short-lived-user-sig",
  expiresAt: "2026-09-14T12:30:00Z",
};

test("Collaboration messaging obtains a Human IM session and owns transport close", async () => {
  const connected: HumanImSession[] = [];
  let closes = 0;
  const service = new CollaborationMessagingService(
    { createHumanImSession: async () => session },
    {
      connect: async (value) => { connected.push(value); },
      close: async () => { closes += 1; },
    },
  );

  await service.connect();
  await service.dispose();
  await service.dispose();

  assert.deepEqual(connected, [session]);
  assert.equal(closes, 1);
});

test("Collaboration workspace loads Servers and connects messaging through one owner", async () => {
  let messagingConnects = 0;
  let messagingDisposals = 0;
	let instanceReads = 0;
  const workspace = new CollaborationWorkspaceService(
    {
      getMe: async () => ({
        id: "account-1",
        displayName: "Ada",
        email: "",
        imState: "ready",
        imUserId: "human-1",
        revision: 1,
      }),
      listServers: async () => ({
        items: [{
          id: "01989c24-7540-7f12-a27b-c83243215dd3",
          slug: "builders",
          name: "Builders",
          ownerMemberId: "01989c24-7540-7f12-a27b-c83243215dd4",
          imState: "ready",
          revision: 2,
        }],
        nextCursor: null,
      }),
	  listComputersV2: async () => [],
	  attachComputerV2: async () => { throw new Error("Computer is disabled"); },
    },
    {
      connect: async () => { messagingConnects += 1; },
      dispose: async () => { messagingDisposals += 1; },
    },
    {
	  listInstances: async () => {
		instanceReads += 1;
		return [{
        instanceId: "instance-1",
        name: "Build Mac",
        status: "paused",
        createdAt: "2026-09-02T00:00:00Z",
		}];
	  },
    },
  );

  await workspace.load();
  assert.deepEqual(workspace.getSnapshot(), {
    phase: "ready",
    account: {
      id: "account-1",
      displayName: "Ada",
      email: "",
      imState: "ready",
      imUserId: "human-1",
      revision: 1,
    },
    servers: [{
      id: "01989c24-7540-7f12-a27b-c83243215dd3",
      slug: "builders",
      name: "Builders",
      ownerMemberId: "01989c24-7540-7f12-a27b-c83243215dd4",
      imState: "ready",
      revision: 2,
    }],
	availableInstances: [],
	computersByServer: {},
    error: null,
    revision: 2,
  });
  assert.equal(messagingConnects, 1);
	assert.equal(instanceReads, 0);

  await workspace.dispose();
  assert.equal(messagingDisposals, 1);
});

test("Tencent Web messaging factory logs in with the issued Human identity", async () => {
  const calls: string[] = [];
  const namespace: TencentChatNamespace = {
    create: ({ SDKAppID }) => {
      calls.push(`create:${SDKAppID}`);
      return {
        createTextAtMessage: () => ({}),
        createTextMessage: () => ({}),
        getMessageList: async () => ({}),
        login: async ({ userID, userSig }) => { calls.push(`login:${userID}:${userSig}`); },
        logout: async () => { calls.push("logout"); },
        off: () => undefined,
        on: () => undefined,
        registerPlugin: () => { calls.push("plugin"); },
        sendMessage: async () => ({}),
      };
    },
    EVENT: {
      KICKED_OUT: "kicked-out",
      MESSAGE_RECEIVED: "message-received",
      SDK_NOT_READY: "not-ready",
      SDK_READY: "ready",
    },
    TYPES: {
      CONV_GROUP: "GROUP",
      KICKED_OUT_USERSIG_EXPIRED: "expired",
      MSG_TEXT: "TIMTextElem",
    },
  };
  const messaging = createTencentWebMessagingPort({ namespace, uploadPlugin: {} });

  await messaging.connect(session);
  await messaging.close();

  assert.deepEqual(calls, [
    "create:1400000001",
    "plugin",
    "login:u_agent_collaborator:short-lived-user-sig",
    "logout",
  ]);
});
