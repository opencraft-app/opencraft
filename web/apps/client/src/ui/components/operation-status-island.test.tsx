import type {Operation} from "@vela/client-core";
import {fireEvent, render} from "@testing-library/react-native";

import {
  deriveOperationStatusIsland,
  OperationStatusIsland,
} from "./operation-status-island";
import type {OperationStatusItem} from "./operation-status-list";

const operation = (
  id: string,
  state: Operation["state"],
  kind = "agent.start",
): Operation => ({
  createdAt: `2026-08-17T15:14:4${id}.000Z`,
  id: `operation-${id}`,
  kind,
  service: "platform",
  state,
});

describe("OperationStatusIsland", () => {
  it("derives exact precedence and terminal progress from existing states", () => {
    const active: OperationStatusItem[] = [
      {operation: operation("1", "succeeded"), pollingState: "terminal"},
      {operation: operation("2", "running"), pollingState: "polling"},
    ];
    expect(deriveOperationStatusIsland(active, null)).toMatchObject({
      busy: true,
      summary: "启动 Agent · 执行中 · 1/2",
      tone: "info",
    });

    expect(deriveOperationStatusIsland([
      ...active,
      {operation: operation("3", "failed", "agent.deploy"), pollingState: "terminal"},
    ], null)).toMatchObject({
      busy: false,
      summary: "部署 Agent · 失败 · 2/3",
      tone: "danger",
    });

    expect(deriveOperationStatusIsland([{
      operation: operation("4", "running"),
      pollingState: "timed_out",
    }], null)).toMatchObject({
      summary: "启动 Agent · 等待继续查询 · 0/1",
      tone: "warning",
    });

    expect(deriveOperationStatusIsland([{
      operation: operation("5", "superseded"),
      pollingState: "terminal",
    }], null)).toMatchObject({
      summary: "操作已更新 · 1/1",
      tone: "neutral",
    });
  });

  it("keeps operation evidence collapsed until requested", async () => {
    const onContinue = jest.fn();
    const screen = await render(
      <OperationStatusIsland
        items={[{
          message: "后台未提供失败详情",
          operation: operation("6", "running"),
          pollingState: "timed_out",
        }]}
        onContinue={onContinue}
        testID="operation-island"
      />,
    );

    expect(screen.getByText("启动 Agent · 等待继续查询 · 0/1")).toBeVisible();
    expect(screen.queryByText("后台执行状态")).toBeNull();
    expect(screen.queryByText("后台未提供失败详情")).toBeNull();

    await fireEvent.press(screen.getByRole("button", {
      name: "启动 Agent · 等待继续查询 · 0/1",
    }));
    expect(screen.getByText("后台未提供失败详情")).toBeVisible();
    fireEvent.press(screen.getByRole("button", {
      name: "继续查询操作 operation-6",
    }));
    expect(onContinue).toHaveBeenCalledWith("operation-6");
  });
});
