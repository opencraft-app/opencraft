import {act} from "react";

import type {
  ConversationPageModel,
  ManagementPageModel,
  WorkspaceSetupModel,
} from "../ui/presentation";
import {terminalPresenter} from "./presenter";
import {
  createReactVaxisRenderer,
  type ReactVaxisRenderer,
} from "./renderer/reconciler";
import type {NativeNode} from "./renderer/node";

const shell = {
  accountLabel: "beordle",
  activeSection: "chat" as const,
  navigation: [
    {id: "navigate-chat", label: "聊天", run: jest.fn()},
    {id: "navigate-agents", label: "Agent", run: jest.fn()},
  ],
  serverName: "111",
  serverOptions: [],
};

async function render(
  renderer: ReactVaxisRenderer,
  element: React.ReactNode,
): Promise<void> {
  let committed: Promise<void> | undefined;
  await act(async () => {
    committed = renderer.render(element);
  });
  await committed;
}

function find(node: NativeNode, testId: string): NativeNode | undefined {
  if (node.testId === testId) return node;
  for (const child of node.children ?? []) {
    const found = find(child, testId);
    if (found) return found;
  }
  return undefined;
}

describe("terminalPresenter", () => {
  it("renders conversation, management and setup semantic models", async () => {
    const renderer = createReactVaxisRenderer(() => undefined);
    const conversation: ConversationPageModel = {
      commands: [],
      composer: {
        disabled: true,
        onChange: jest.fn(),
        onSend: jest.fn(),
        placeholder: "给 #general 发消息",
        value: "",
        actions: [],
      },
      conversations: [
        {
          id: "channel-1",
          kind: "channel",
          onSelect: jest.fn(),
          selected: true,
          title: "# general",
        },
      ],
      empty: {description: "正在修复成员资格", title: "正在重新连接"},
      error: "消息服务暂时不可用",
      header: {eyebrow: "111 / CHAT", title: "# general"},
      messages: [],
      shell,
    };
    await render(
      renderer,
      terminalPresenter.renderConversationPage(conversation, null),
    );
    expect(find(renderer.latestSnapshot()!, "terminal-conversation-frame")).toBeDefined();
    expect(find(renderer.latestSnapshot()!, "terminal-navigation-navigate-agents")).toBeDefined();
    expect(find(renderer.latestSnapshot()!, "terminal-conversation-error")?.text).toBe(
      "消息服务暂时不可用",
    );

    const management: ManagementPageModel = {
      commands: [{id: "create-agent", label: "新建 Agent", run: jest.fn()}],
      empty: {description: "还没有 Agent", title: "Agent"},
      header: {eyebrow: "111", title: "Agent"},
      id: "agents",
      shell: {...shell, activeSection: "agents"},
    };
    await render(
      renderer,
      terminalPresenter.renderManagementPage(management, null),
    );
    expect(find(renderer.latestSnapshot()!, "terminal-management-frame")).toBeDefined();
    expect(find(renderer.latestSnapshot()!, "terminal-management-empty")?.text).toContain(
      "还没有 Agent",
    );
    expect(
      find(renderer.latestSnapshot()!, "terminal-management-command-create-agent")
        ?.title,
    ).toBe("新建 Agent");

    const setup: WorkspaceSetupModel = {
      description: "创建第一个协作空间",
      form: {actions: [], fields: [], title: "Server"},
      title: "建立你的第一个 Server",
    };
    await render(renderer, terminalPresenter.renderWorkspaceSetup(setup, null));
    expect(find(renderer.latestSnapshot()!, "terminal-workspace-setup-frame")).toBeDefined();
  });
});
