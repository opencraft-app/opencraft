import {act, fireEvent, render, waitFor} from "@testing-library/react-native";
import type {Server} from "@vela/client-core";
import {Text} from "react-native";
import {createStore} from "zustand/vanilla";

import type {AppStoreState} from "../../application/app-store";
import {AppRuntimeProvider} from "../../runtime/app-runtime";
import {ServerRouteBoundary} from "./server-route-boundary";

const mockReplace = jest.fn();

jest.mock("expo-router", () => ({
  Redirect: ({href}: {href: string}) => {
    const {Text: MockText} = jest.requireActual("react-native");
    return <MockText>{href}</MockText>;
  },
  useRouter: () => ({replace: mockReplace}),
}));

const server = {
  id: "019fb723-68b8-79ac-b31e-9d0a657c43ec",
  imState: "ready" as const,
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
};

describe("ServerRouteBoundary", () => {
  beforeEach(() => mockReplace.mockClear());

  it("activates a visible Server by ID and replaces only the legacy URL", async () => {
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        error: null,
        currentServerId: null,
        retryInitialization: jest.fn(),
        retryServers: jest.fn(),
        selectServer: jest.fn(),
        serverContextStatus: "idle",
        servers: [server],
        serversStatus: "ready",
        targetServerId: null,
      }) as unknown as AppStoreState,
    );
    store.setState({
      selectServer: jest.fn(async (serverId: string) => {
        await act(async () => {
          store.setState({
            currentServerId: serverId,
            serverContextStatus: "ready",
            targetServerId: serverId,
          });
        });
      }),
    });

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ServerRouteBoundary
          canonicalHref={(slug) => `/s/${slug}/tasks`}
          serverReference={server.id}
        >
          {(resolved) => <Text>打开 {resolved.name}</Text>}
        </ServerRouteBoundary>
      </AppRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByText("打开 Atlas")).toBeVisible());
    expect(store.getState().selectServer).toHaveBeenCalledWith(server.id);
    expect(mockReplace).toHaveBeenCalledWith("/s/atlas/tasks");
  });

  it("keeps an unavailable Server URL stable and offers a useful state", async () => {
    const selectServer = jest.fn();
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        error: null,
        currentServerId: null,
        retryInitialization: jest.fn(),
        retryServers: jest.fn(),
        selectServer,
        serverContextStatus: "idle",
        servers: [server],
        serversStatus: "ready",
        targetServerId: null,
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ServerRouteBoundary
          canonicalHref={(slug) => `/s/${slug}`}
          serverReference="private-or-missing"
        >
          {() => <Text>不应出现</Text>}
        </ServerRouteBoundary>
      </AppRuntimeProvider>,
    );

    expect(screen.getByText("Server 不可用")).toBeVisible();
    expect(screen.queryByText("不应出现")).toBeNull();
    expect(selectServer).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("lets the user retry a failed Server context without changing the URL", async () => {
    const selectServer = jest.fn(async () => undefined);
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        currentServerId: null,
        error: "网络暂时不可用",
        retryInitialization: jest.fn(),
        retryServers: jest.fn(),
        selectServer,
        serverContextStatus: "error",
        servers: [server],
        serversStatus: "ready",
        targetServerId: server.id,
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ServerRouteBoundary
          canonicalHref={(slug) => `/s/${slug}`}
          serverReference={server.slug}
        >
          {() => <Text>不应出现</Text>}
        </ServerRouteBoundary>
      </AppRuntimeProvider>,
    );

    fireEvent.press(screen.getByRole("button", {name: "重新加载 Server"}));
    expect(selectServer).toHaveBeenCalledWith(server.id);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does not rerender the resolved route when unrelated conversation state changes", async () => {
    const renderChild = jest.fn((resolved: Server) => (
      <Text>打开 {resolved.name}</Text>
    ));
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        currentServerId: server.id,
        error: null,
        retryInitialization: jest.fn(),
        retryServers: jest.fn(),
        selectServer: jest.fn(),
        sendingMessage: false,
        serverContextStatus: "ready",
        servers: [server],
        serversStatus: "ready",
        targetServerId: server.id,
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ServerRouteBoundary
          canonicalHref={(slug) => `/s/${slug}`}
          serverReference={server.slug}
        >
          {renderChild}
        </ServerRouteBoundary>
      </AppRuntimeProvider>,
    );
    expect(screen.getByText("打开 Atlas")).toBeVisible();
    expect(renderChild).toHaveBeenCalledTimes(1);

    await act(async () => {
      store.setState({sendingMessage: true});
    });

    expect(renderChild).toHaveBeenCalledTimes(1);
  });
});
