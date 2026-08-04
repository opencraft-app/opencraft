import {fireEvent, render} from "@testing-library/react-native";
import {ServerRoot} from "./server-root";

jest.mock("expo-router", () => ({
  Redirect: ({href}: {href: string}) => {
    const {Text: MockText} = jest.requireActual("react-native");
    return <MockText>{href}</MockText>;
  },
  Stack: {Screen: () => null},
  useFocusEffect: (effect: () => void) => effect(),
}));

const server = {
  id: "server-1",
  imState: "ready" as const,
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
};

describe("ServerRoot", () => {
  it("redirects to the Server all-members Topic before ordinary Channels", async () => {
    const screen = await render(
      <ServerRoot
        channels={[
          {
            id: "channel-all",
            joined: true,
            imGroupId: "community-1",
            imState: "ready",
            imTopicId: "topic-all",
            name: "全员",
            revision: 1,
            serverId: server.id,
            systemKey: "all",
            visibility: "public",
          },
          {
            id: "channel-general",
            joined: true,
            imGroupId: "community-1",
            imState: "ready",
            imTopicId: "topic-general",
            name: "闲聊",
            revision: 1,
            serverId: server.id,
            visibility: "public",
          },
        ]}
        onRetry={() => undefined}
        server={server}
      />,
    );

    expect(screen.getByText("/s/atlas/c/channel-all")).toBeVisible();
  });

  it("keeps the Server root visible while Channels are still syncing", async () => {
    const onRetry = jest.fn();
    const screen = await render(
      <ServerRoot
        channels={[
          {
            id: "channel-general",
            joined: true,
            imState: "provisioning",
            name: "闲聊",
            revision: 1,
            serverId: server.id,
            visibility: "public",
          },
        ]}
        onRetry={onRetry}
        server={server}
      />,
    );

    expect(screen.getByText("频道正在同步")).toBeVisible();
    expect(screen.queryByText(/\/s\/atlas\/c\//)).toBeNull();
    fireEvent.press(screen.getByRole("button", {name: "重新检查"}));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a Channel synchronization failure instead of a waiting state", async () => {
    const screen = await render(
      <ServerRoot
        channels={[
          {
            id: "channel-general",
            joined: true,
            imGroupId: "community-1",
            imState: "error",
            imTopicId: "topic-general",
            name: "闲聊",
            revision: 1,
            serverId: server.id,
            visibility: "public",
          },
        ]}
        onRetry={() => undefined}
        server={server}
      />,
    );

    expect(screen.getByText("频道同步失败")).toBeVisible();
    expect(screen.queryByText("频道正在同步")).toBeNull();
  });

  it("does not describe an empty Channel list as synchronization", async () => {
    const screen = await render(
      <ServerRoot
        channels={[]}
        onRetry={() => undefined}
        server={server}
      />,
    );

    expect(screen.getByText("暂无可用频道")).toBeVisible();
    expect(screen.queryByText("频道正在同步")).toBeNull();
  });
});
