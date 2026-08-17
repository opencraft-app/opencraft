import type {NativeNode} from "./renderer/node";
import {
  createTuiApplication,
  type TuiFacade,
} from "./entry";
import type {NativeModulesBridge} from "./native-modules";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function find(node: NativeNode | null, testId: string): NativeNode | undefined {
  if (!node) return undefined;
  if (node.testId === testId) return node;
  for (const child of node.children ?? []) {
    const found = find(child, testId);
    if (found) return found;
  }
  return undefined;
}

describe("Human TUI entry", () => {
  it("replaces the application with a useful remediation on narrow terminals", async () => {
    let latest: NativeNode | null = null;
    const bridge: NativeModulesBridge = {
      async call(module, method) {
        if (module === "platform.v1" && method === "restore") {
          throw {code: "AUTH_REQUIRED", message: "Human 尚未登录"};
        }
        return null;
      },
      protocol: "reactvaxis-native-module/v1",
      subscribe: jest.fn((_module, _topic, _payload, options) =>
        options.subscriptionId,
      ),
      unsubscribe: jest.fn(),
    };
    const application = createTuiApplication({
      bridge,
      commit(tree) {
        latest = tree;
      },
    });

    application.facade.start();
    await eventually(() => expect(find(latest, "human-auth-email")).toBeDefined());
    application.facade.resize(80, 24);

    await eventually(() => {
      const remediation = find(latest, "terminal-width-remediation");
      expect(remediation).toBeDefined();
      expect(JSON.stringify(remediation)).toContain("终端宽度不足");
      expect(find(latest, "human-auth-email")).toBeUndefined();
    });
    await application.renderer.unmount();
  });

  it("renders canonical login when native session restore is unavailable", async () => {
    let latest: NativeNode | null = null;
    const bridge: NativeModulesBridge = {
      async call(module, method) {
        if (module === "platform.v1" && method === "restore") {
          throw {code: "AUTH_REQUIRED", message: "Human 尚未登录"};
        }
        return null;
      },
      protocol: "reactvaxis-native-module/v1",
      subscribe: jest.fn((_module, _topic, _payload, options) =>
        options.subscriptionId,
      ),
      unsubscribe: jest.fn(),
    };
    const application = createTuiApplication({
      bridge,
      commit(tree) {
        latest = tree;
      },
    });

    const facade: TuiFacade = application.facade;
    facade.start();
    await eventually(() => {
      expect(find(latest, "human-auth-email")).toBeDefined();
      expect(find(latest, "human-auth-password")?.secureTextEntry).toBe(true);
      expect(find(latest, "human-auth-submit")?.title).toBe("登录");
    });
    await application.renderer.unmount();
  });

  it("restores the first Server into the shared conversation model", async () => {
    let latest: NativeNode | null = null;
    const createdComputers: Array<Record<string, unknown>> = [];
    const account = {
      displayName: "Beordle",
      email: "beordle@example.test",
      id: "account-1",
      imState: "ready",
      imUserId: "human-1",
      revision: 1,
    };
    const bridge: NativeModulesBridge = {
      async call(module, method, payload) {
        if (module === "platform.v1" && method === "restore") return account;
        if (module === "platform.v1" && method === "request") {
          const path = (payload as {path: string}).path;
          if (path === "/me") return account;
          if (path === "/servers") {
            return {
              items: [
                {
                  id: "server-1",
                  imState: "ready",
                  name: "111",
                  ownerMemberId: "member-1",
                  revision: 1,
                  slug: "11111",
                },
              ],
              nextCursor: null,
            };
          }
          if (path === "/servers/server-1/channels") {
            return [
              {
                id: "channel-1",
                imGroupId: "community-1",
                imState: "ready",
                imTopicId: "topic-1",
                joined: true,
                name: "general",
                revision: 1,
                serverId: "server-1",
                visibility: "public",
              },
            ];
          }
          if (path === "/servers/server-1/members") {
            return {
              items: [
                {
                  accountId: "account-1",
                  displayName: "Beordle",
                  handle: "beordle",
                  id: "member-1",
                  imState: "ready",
                  imUserId: "human-1",
                  kind: "human",
                  revision: 1,
                  role: "owner",
                  serverId: "server-1",
                  status: "active",
                },
              ],
              nextCursor: null,
            };
          }
          if (path === "/servers/server-1/direct-conversations") {
            return {items: [], nextCursor: null};
          }
          if (path === "/servers/server-1/agents") {
            return [];
          }
          if (path === "/servers/server-1/computers") {
            const request = payload as {
              body?: Record<string, unknown>;
              method?: string;
            };
            if (request.method === "POST") {
              createdComputers.push(request.body ?? {});
              return {
                connectionState: "waiting",
                id: "computer-1",
                lifecycleState: "active",
                name: request.body?.name,
                osType: request.body?.osType,
                revision: 1,
                serverId: "server-1",
              };
            }
            return [];
          }
          if (path === "/servers/server-1/channels/channel-1/members") {
            return [];
          }
          throw new Error(`unexpected platform path ${path}`);
        }
        if (module === "messaging.v1" && method === "listConversations") {
          return {isSyncCompleted: true, items: []};
        }
        if (module === "messaging.v1" && method === "loadHistory") {
          return {completed: true, messages: []};
        }
        return null;
      },
      protocol: "reactvaxis-native-module/v1",
      subscribe: jest.fn((_module, _topic, _payload, options) =>
        options.subscriptionId,
      ),
      unsubscribe: jest.fn(),
    };
    const application = createTuiApplication({
      bridge,
      commit(tree) {
        latest = tree;
      },
    });

    application.facade.start();
    await eventually(() => {
      expect(find(latest, "terminal-conversation-frame")).toBeDefined();
      expect(find(latest, "terminal-conversation-item-channel-1")?.title).toBe(
        "# general",
      );
      expect(find(latest, "terminal-navigation-navigate-agents")).toBeDefined();
    });

    application.facade.dispatch(
      find(latest, "terminal-navigation-navigate-computers")!.onPress!,
      {source: "keyboard"},
    );
    await eventually(() =>
      expect(
        find(latest, "terminal-management-command-create-computer"),
      ).toBeDefined(),
    );
    expect(
      application.facade.dispatch(
        find(latest, "terminal-management-command-create-computer")!.onPress!,
        {source: "keyboard"},
      ),
    ).toBe(true);
    await eventually(() => {
      expect(find(latest, "terminal-management-form-field-computer-name")).toBeDefined();
      expect(find(latest, "terminal-management-form-field-computer-os")).toBeDefined();
    });
    application.facade.dispatch(
      find(latest, "terminal-management-form-field-computer-name")!.onChangeText!,
      {eventCount: 1, value: "Linux 验收"},
    );
    application.facade.dispatch(
      find(latest, "terminal-management-form-field-computer-os")!.onValueChange!,
      {value: "linux"},
    );
    await eventually(() => {
      expect(
        find(latest, "terminal-management-form-field-computer-name")?.value,
      ).toBe("Linux 验收");
      expect(find(latest, "terminal-management-form-field-computer-os")?.value).toBe(
        "linux",
      );
    });
    application.facade.dispatch(
      find(latest, "terminal-management-form-action-submit-computer")!.onPress!,
      {source: "keyboard"},
    );
    await eventually(() => {
      expect(createdComputers).toEqual([{name: "Linux 验收", osType: "linux"}]);
      expect(find(latest, "terminal-management-form-overlay")).toBeUndefined();
    });
    await application.renderer.unmount();
  });
});
