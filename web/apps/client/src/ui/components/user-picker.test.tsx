import {fireEvent, render, within} from "@testing-library/react-native";
import {Text} from "react-native";

import {UserPicker} from "./user-picker";

interface FixtureUser {
  handle: string;
  id: string;
  name: string;
}

const currentUsers: FixtureUser[] = [
  {handle: "atlas", id: "atlas", name: "Atlas Agent"},
  {handle: "linmo", id: "linmo", name: "林墨"},
];

const availableUsers: FixtureUser[] = [
  {handle: "runtime", id: "runtime", name: "Runtime Agent"},
];

describe("UserPicker", () => {
  it("filters every section by searchable values and clears the query", async () => {
    const screen = await render(
      <UserPicker
        accessibilityLabel="搜索成员"
        emptyDescription="换个关键词试试。"
        emptyTitle="没有匹配的成员。"
        getItemKey={(item) => item.id}
        getSearchValues={(item) => [item.name, item.handle]}
        placeholder="搜索成员或 @handle"
        renderItem={(item) => <Text>{item.name}</Text>}
        sections={[
          {id: "current", items: currentUsers, title: "当前成员"},
          {id: "available", items: availableUsers, title: "添加成员"},
        ]}
      />,
    );

    await fireEvent.changeText(screen.getByLabelText("搜索成员"), "runtime");

    expect(screen.getByText("Runtime Agent")).toBeVisible();
    expect(screen.queryByText("Atlas Agent")).toBeNull();
    expect(screen.queryByText("当前成员")).toBeNull();
    expect(
      within(screen.getByTestId("user-picker-section-available")).getByText(
        "1 / 1",
      ),
    ).toBeVisible();

    await fireEvent.changeText(screen.getByLabelText("搜索成员"), "unknown");
    expect(screen.getByText("没有匹配的成员。")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "清除成员搜索"}),
    );
    expect(screen.getByText("Atlas Agent")).toBeVisible();
    expect(screen.getByText("Runtime Agent")).toBeVisible();
  });

  it("can preserve a useful section-level empty state before searching", async () => {
    const screen = await render(
      <UserPicker
        accessibilityLabel="搜索成员"
        emptyDescription="换个关键词试试。"
        emptyTitle="没有匹配的成员。"
        getItemKey={(item: FixtureUser) => item.id}
        getSearchValues={(item) => [item.name, item.handle]}
        renderItem={(item) => <Text>{item.name}</Text>}
        sections={[
          {
            emptyText: "所有 Agent 都已加入。",
            id: "agents",
            items: [],
            title: "添加 Agent",
          },
        ]}
      />,
    );

    expect(screen.getByText("添加 Agent")).toBeVisible();
    expect(screen.getByText("所有 Agent 都已加入。")).toBeVisible();
  });

  it("allows a full-screen task to provide its own search-empty presentation", async () => {
    const screen = await render(
      <UserPicker
        accessibilityLabel="搜索成员"
        emptyContent={<Text>自定义搜索空态</Text>}
        emptyDescription="换个关键词试试。"
        emptyTitle="没有匹配的成员。"
        getItemKey={(item: FixtureUser) => item.id}
        getSearchValues={(item) => [item.name, item.handle]}
        renderItem={(item) => <Text>{item.name}</Text>}
        sections={[
          {id: "current", items: currentUsers, title: "当前成员"},
        ]}
      />,
    );

    await fireEvent.changeText(screen.getByLabelText("搜索成员"), "unknown");

    expect(screen.getByText("自定义搜索空态")).toBeVisible();
    expect(screen.queryByText("没有匹配的成员。")).toBeNull();
  });
});
