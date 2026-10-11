import { fireEvent, render } from "@testing-library/react-native";

import {
  ClearableSearchField,
  SearchEmptyCard,
} from "./clearable-search-field";

describe("ClearableSearchField", () => {
  it("shows a clear control only while there is a query", async () => {
    const onChangeText = jest.fn();
    const screen = await render(
      <ClearableSearchField
        accessibilityLabel="搜索频道、私信与成员"
        clearAccessibilityLabel="清除会话搜索"
        onChangeText={onChangeText}
        placeholder="搜索频道、私信与成员"
        value=""
      />,
    );

    expect(screen.queryByRole("button", { name: "清除会话搜索" })).toBeNull();

    await screen.rerender(
      <ClearableSearchField
        accessibilityLabel="搜索频道、私信与成员"
        clearAccessibilityLabel="清除会话搜索"
        onChangeText={onChangeText}
        placeholder="搜索频道、私信与成员"
        value="general"
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "清除会话搜索" }));
    expect(onChangeText).toHaveBeenCalledWith("");
  });

  it("ignores whitespace-only queries for the clear control", async () => {
    const screen = await render(
      <ClearableSearchField
        accessibilityLabel="搜索"
        onChangeText={() => undefined}
        value="   "
      />,
    );

    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
  });
});

describe("SearchEmptyCard", () => {
  it("names the miss and suggests what to try", async () => {
    const screen = await render(
      <SearchEmptyCard
        description="换个关键词试试。"
        title="没有匹配的会话。"
      />,
    );

    expect(screen.getByText("没有匹配的会话。")).toBeVisible();
    expect(screen.getByText("换个关键词试试。")).toBeVisible();
  });
});
