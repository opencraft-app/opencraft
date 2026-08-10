import type {Computer} from "@vela/client-core";
import {fireEvent, render, waitFor} from "@testing-library/react-native";

import {ServerSetupScreen} from "@/ui";

const onlineComputer = {
  connectionState: "online",
  id: "computer-1",
  lifecycleState: "active",
  name: "研发机",
} as Computer;

const requiredProps = {
  error: null,
  onContinue: jest.fn(),
  onCreateAgent: jest.fn(),
  onCreateComputer: jest.fn(),
  onOpenAgents: jest.fn(),
  onRefreshAgents: jest.fn(),
  onRefreshComputers: jest.fn(),
  onRequestRegistrationScript: jest.fn(),
  pendingAction: null,
  serverName: "Atlas",
};

describe("ServerSetupScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a Computer and immediately requests its one-time install command", async () => {
    const created = {...onlineComputer, connectionState: "offline"} as Computer;
    const onCreateComputer = jest.fn(async () => created);
    const onRequestRegistrationScript = jest.fn(async () => null);
    const screen = await render(
      <ServerSetupScreen
        {...requiredProps}
        onCreateComputer={onCreateComputer}
        onRequestRegistrationScript={onRequestRegistrationScript}
        readiness={{stage: "connect_computer"}}
      />,
    );

    await fireEvent.changeText(
      screen.getByLabelText("Computer 名称"),
      "本地开发机",
    );
    await waitFor(() => {
      expect(screen.getByRole("button", {name: "生成连接命令"})).toBeEnabled();
    });
    await fireEvent.press(
      screen.getByRole("button", {name: "生成连接命令"}),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreateComputer).toHaveBeenCalledWith({name: "本地开发机"});
    expect(onRequestRegistrationScript).toHaveBeenCalledWith(created.id);
  });

  it("creates and starts an Agent on the online Computer", async () => {
    const onCreateAgent = jest.fn(async () => ({
      operations: [],
      resourceId: "agent-1",
    }));
    const screen = await render(
      <ServerSetupScreen
        {...requiredProps}
        onCreateAgent={onCreateAgent}
        readiness={{computerId: onlineComputer.id, stage: "create_agent"}}
      />,
    );

    await fireEvent.changeText(
      screen.getByLabelText("Agent 名称"),
      "研究助手",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Agent Handle"),
      "research",
    );
    await waitFor(() => {
      expect(screen.getByRole("button", {name: "创建并启动 Agent"})).toBeEnabled();
    });
    await fireEvent.press(
      screen.getByRole("button", {name: "创建并启动 Agent"}),
    );
    expect(onCreateAgent).toHaveBeenCalledWith(
      {
        computerId: onlineComputer.id,
        displayName: "研究助手",
        handle: "research",
        replyPolicy: "mention_and_dm",
        runtime: {kind: "codex"},
      },
      {deployAndStart: true},
    );
  });
});
