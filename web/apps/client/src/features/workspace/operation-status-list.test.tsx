import type {Operation} from "@vela/client-core";
import {fireEvent, render} from "@testing-library/react-native";

import {OperationStatusList} from "@/ui";

const operation: Operation = {
  createdAt: "2026-08-01T03:00:00.000Z",
  id: "operation-1",
	kind: "agent.credential.rotate",
	service: "platform",
  state: "uncertain",
};

describe("OperationStatusList", () => {
	it("uses the platform credential rotation label", async () => {
		const screen = await render(
			<OperationStatusList
				items={[{operation, pollingState: "terminal"}]}
				onContinue={jest.fn()}
			/>,
		);
		expect(screen.getByText("轮换运行凭证")).toBeVisible();
		expect(screen.queryByText("agent.credential.rotate")).toBeNull();
	});

  it("exposes a continuation for a nonterminal operation whose polling paused", async () => {
    const onContinue = jest.fn();
    const screen = await render(
      <OperationStatusList
        items={[{
          message: "后台未提供失败详情",
          operation: {...operation, state: "running"},
          pollingState: "timed_out",
        }]}
        onContinue={onContinue}
      />,
    );

    expect(screen.getByText("执行中")).toBeVisible();
    expect(screen.getByText("后台未提供失败详情")).toBeVisible();
    fireEvent.press(
      screen.getByRole("button", {name: "继续查询操作 operation-1"}),
    );
    expect(onContinue).toHaveBeenCalledWith(operation.id);
  });

  it("shows deterministic fallbacks for sparse terminal operations", async () => {
    const screen = await render(
      <OperationStatusList
        items={[{
          operation: {...operation, state: "failed"},
          pollingState: "terminal",
        }]}
        onContinue={jest.fn()}
      />,
    );

    expect(screen.getByText("失败")).toBeVisible();
    expect(screen.getByText("后台未提供失败详情")).toBeVisible();
    expect(screen.getByText("完成时间未知")).toBeVisible();
  });

  it("keeps uncertain as its own terminal result", async () => {
    const screen = await render(
      <OperationStatusList
        items={[{operation, pollingState: "terminal"}]}
        onContinue={jest.fn()}
      />,
    );

    expect(screen.getByText("结果不确定")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
