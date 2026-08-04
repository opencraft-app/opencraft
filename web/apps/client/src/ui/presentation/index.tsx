import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

export type PresentationKind = "graphical" | "terminal";

export interface PresentationAction {
  disabled?: boolean;
  id: string;
  kind?: "danger" | "primary" | "secondary";
  label: string;
  run(): unknown | Promise<unknown>;
  shortcut?: string;
}

export interface PresentationField {
  disabled?: boolean;
  id: string;
  label: string;
  multiline?: boolean;
  onChange(value: string): void;
  options?: Array<{
    label: string;
    value: string;
  }>;
  placeholder?: string;
  value: string;
}

export interface PresentationForm {
  actions: PresentationAction[];
  fields: PresentationField[];
  title: string;
}

export interface ManagementCollectionItem {
  id: string;
  meta?: string;
  onSelect(): void;
  selected: boolean;
  status?: string;
  subtitle?: string;
  title: string;
}

export interface ManagementDetail {
  actions: PresentationAction[];
  description?: string;
  meta?: string;
  status?: string;
  title: string;
}

export interface ManagementShellModel {
  accountLabel?: string;
  activeSection: "agents" | "chat" | "computers" | "members" | "tasks";
  navigation: PresentationAction[];
  onLogout?: () => void | Promise<void>;
  serverName?: string;
  serverOptions?: Array<{
    id: string;
    label: string;
    onSelect(): void | Promise<void>;
    selected: boolean;
  }>;
}

export interface ManagementPageModel {
  collection: {
    items: ManagementCollectionItem[];
    label: string;
  };
  commands: PresentationAction[];
  detail?: ManagementDetail;
  empty?: {
    action?: PresentationAction;
    description: string;
    title: string;
  };
  error?: string;
  form?: PresentationForm;
  header: {
    eyebrow: string;
    summary?: string;
    title: string;
  };
  id: ManagementShellModel["activeSection"];
  segments?: Array<{
    id: string;
    label: string;
    onSelect(): void;
    selected: boolean;
  }>;
  shell: ManagementShellModel;
}

export interface ConversationItemModel {
  id: string;
  kind: "channel" | "direct";
  onSelect(): void | Promise<void>;
  selected: boolean;
  status?: string;
  subtitle?: string;
  title: string;
  unreadCount?: number;
}

export interface ConversationMessageModel {
  actions: PresentationAction[];
  id: string;
  meta?: string;
  sender: string;
  text: string;
}

export interface ConversationComposerModel {
  actions: PresentationAction[];
  disabled?: boolean;
  onChange(value: string): void;
  onSend(): void | Promise<void>;
  placeholder: string;
  value: string;
}

export interface ConversationPageModel {
  commands: PresentationAction[];
  composer: ConversationComposerModel;
  conversations: ConversationItemModel[];
  empty?: {
    description: string;
    title: string;
  };
  error?: string;
  form?: PresentationForm;
  header: {
    eyebrow: string;
    summary?: string;
    title: string;
  };
  messages: ConversationMessageModel[];
  shell: ManagementShellModel;
}

export interface WorkspaceSetupModel {
  description: string;
  error?: string;
  form: PresentationForm;
  stage?: string | null;
  title: string;
}

export interface HumanClientPresenter {
  kind: PresentationKind;
  renderConversationPage(
    model: ConversationPageModel,
    graphicalFallback: ReactNode,
  ): ReactNode;
  renderManagementPage(
    model: ManagementPageModel,
    graphicalFallback: ReactNode,
  ): ReactNode;
  renderWorkspaceSetup(
    model: WorkspaceSetupModel,
    graphicalFallback: ReactNode,
  ): ReactNode;
}

export const graphicalPresenter: HumanClientPresenter = {
  kind: "graphical",
  renderConversationPage(_model, graphicalFallback) {
    return graphicalFallback;
  },
  renderManagementPage(_model, graphicalFallback) {
    return graphicalFallback;
  },
  renderWorkspaceSetup(_model, graphicalFallback) {
    return graphicalFallback;
  },
};

const PresentationContext = createContext<HumanClientPresenter>(
  graphicalPresenter,
);

export function PresentationProvider({
  children,
  presenter,
}: {
  children: ReactNode;
  presenter: HumanClientPresenter;
}) {
  return (
    <PresentationContext.Provider value={presenter}>
      {children}
    </PresentationContext.Provider>
  );
}

export function ConversationPresentation({
  children,
  model,
}: {
  children: ReactNode;
  model: ConversationPageModel | (() => ConversationPageModel);
}) {
  const presenter = useContext(PresentationContext);
  if (presenter.kind === "graphical") return children;
  return presenter.renderConversationPage(
    typeof model === "function" ? model() : model,
    children,
  );
}

export function ManagementPresentation({
  children,
  model,
}: {
  children: ReactNode;
  model: ManagementPageModel | (() => ManagementPageModel);
}) {
  const presenter = useContext(PresentationContext);
  if (presenter.kind === "graphical") return children;
  return presenter.renderManagementPage(
    typeof model === "function" ? model() : model,
    children,
  );
}

export function WorkspaceSetupPresentation({
  children,
  model,
}: {
  children: ReactNode;
  model: WorkspaceSetupModel;
}) {
  const presenter = useContext(PresentationContext);
  return presenter.renderWorkspaceSetup(model, children);
}

export function useHumanClientPresenter(): HumanClientPresenter {
  return useContext(PresentationContext);
}
