import {render} from "@testing-library/react-native";
import {Text} from "react-native";

import {
  ConversationPresentation,
  ManagementPresentation,
  PresentationProvider,
  type ConversationPageModel,
  type HumanClientPresenter,
  type ManagementPageModel,
} from "./index";

const conversationModel = (): ConversationPageModel => ({
  commands: [],
  composer: {
    actions: [],
    onChange: () => undefined,
    onSend: () => undefined,
    placeholder: "",
    value: "",
  },
  conversations: [],
  header: {eyebrow: "聊天", title: "语义聊天"},
  messages: [],
  shell: {activeSection: "chat", navigation: []},
});

const managementModel = (): ManagementPageModel => ({
  collection: {items: [], label: "Agent"},
  commands: [],
  header: {eyebrow: "管理", title: "语义管理"},
  id: "agents",
  shell: {activeSection: "agents", navigation: []},
});

describe("presentation model factories", () => {
  it("builds one shared model for graphical renderers", async () => {
    const buildConversation = jest.fn(conversationModel);
    const buildManagement = jest.fn(managementModel);
    const screen = await render(
      <>
        <ConversationPresentation model={buildConversation}>
          {(model) => <Text>{model.header.title} · 图形聊天</Text>}
        </ConversationPresentation>
        <ManagementPresentation model={buildManagement}>
          {(model) => <Text>{model.header.title} · 图形管理</Text>}
        </ManagementPresentation>
      </>,
    );

    expect(screen.getByText("语义聊天 · 图形聊天")).toBeVisible();
    expect(screen.getByText("语义管理 · 图形管理")).toBeVisible();
    expect(buildConversation).toHaveBeenCalledTimes(1);
    expect(buildManagement).toHaveBeenCalledTimes(1);
  });

  it("builds semantic models for the terminal presenter", async () => {
    const buildConversation = jest.fn(conversationModel);
    const buildManagement = jest.fn(managementModel);
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(model) {
        return <Text>{model.header.title}</Text>;
      },
      renderManagementPage(model) {
        return <Text>{model.header.title}</Text>;
      },
      renderWorkspaceSetup(_model, fallback) {
        return fallback;
      },
    };
    const screen = await render(
      <PresentationProvider presenter={presenter}>
        <ConversationPresentation model={buildConversation}>
          <Text>图形聊天</Text>
        </ConversationPresentation>
        <ManagementPresentation model={buildManagement}>
          <Text>图形管理</Text>
        </ManagementPresentation>
      </PresentationProvider>,
    );

    expect(screen.getByText("语义聊天")).toBeVisible();
    expect(screen.getByText("语义管理")).toBeVisible();
    expect(buildConversation).toHaveBeenCalledTimes(1);
    expect(buildManagement).toHaveBeenCalledTimes(1);
  });
});
