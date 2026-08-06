import {fireEvent, render} from "@testing-library/react-native";
import {Text} from "react-native";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import type {ComponentType, ReactNode} from "react";

import * as managementWorkspace from "./management-workspace";

import {
  ActionButton,
  CollectionIdentityMark,
  CollectionRow,
  CodeBlock,
  DetailHeading,
  DetailSection,
  IconActionButton,
  InlineEmptyState,
  ManagementCollectionPane,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementHeader,
  ManagementTab,
  ManagementTabBar,
  NoticeBanner,
  RecordIdentityHeader,
  ResourceFactStrip,
  ResourceIdentityHeader,
  ResourceMetadataList,
  ManagementStage,
  ResourceActionRow,
  StatusIndicator,
  SelectionButton,
  SelectionGroup,
} from "./management-workspace";
import {velaTheme} from "../tokens";

describe("management workspace primitives", () => {
  it("provides the complete semantic primitive set", () => {
    expect([
      ActionButton,
      CollectionIdentityMark,
      CollectionRow,
      CodeBlock,
      DetailHeading,
      DetailSection,
      IconActionButton,
      InlineEmptyState,
      ManagementCollectionPane,
      ManagementDetailCanvas,
      ManagementDetailScroll,
      ManagementHeader,
      ManagementTab,
      ManagementTabBar,
      NoticeBanner,
      RecordIdentityHeader,
      ResourceFactStrip,
      ResourceIdentityHeader,
      ResourceMetadataList,
      managementWorkspace.ManagementResourceSwitcher,
      ManagementStage,
      ResourceActionRow,
      StatusIndicator,
      SelectionButton,
      SelectionGroup,
    ]).not.toContain(undefined);
  });

  it("gives collection identities one shared mark and presence language", async () => {
    const screen = await render(
      <>
        <CollectionIdentityMark
          identityKind="agent"
          monogram="研"
          presence={{label: "在线", tone: "positive"}}
          testID="agent-collection-mark"
        />
        <CollectionIdentityMark
          icon={RefreshCw}
          presence={{label: "等待连接", tone: "neutral"}}
          testID="computer-collection-mark"
        />
      </>,
    );

    expect(screen.getByTestId("agent-collection-mark")).toHaveStyle({
      backgroundColor: "#17C964",
      borderRadius: velaTheme.semantic.radius.circle,
      height: velaTheme.recipes.identity.avatarRowSize,
      width: velaTheme.recipes.identity.avatarRowSize,
    });
    expect(screen.getByTestId("computer-collection-mark")).toHaveStyle({
      borderRadius: velaTheme.semantic.radius.control,
    });
    expect(screen.getByTestId("agent-collection-mark-presence")).toHaveStyle({
      backgroundColor: "#17C964",
      height: 10,
      width: 10,
    });
    expect(screen.getByTestId("computer-collection-mark")).toHaveStyle({
      backgroundColor: "#EAF4FF",
    });
    expect(screen.getByTestId("computer-collection-mark-presence")).toHaveStyle({
      backgroundColor: "#D4D4D8",
    });
  });

  it("provides semantic notice and code surfaces for sensitive operations", async () => {
    const screen = await render(
      <NoticeBanner
        actions={<Text>关闭</Text>}
        description="请勿粘贴到聊天或日志。"
        testID="registration-notice"
        title="一键安装命令"
        tone="info"
      >
        <CodeBlock testID="registration-code" value="curl example.test/install" />
      </NoticeBanner>,
    );

    expect(screen.getByTestId("registration-notice")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.statusInfoSurface,
      borderBottomWidth: 1,
    });
    expect(screen.getByTestId("registration-code")).toHaveStyle({
      backgroundColor: "#18181B",
      borderRadius: 10,
      maxHeight: 180,
    });
    expect(screen.getByText("curl example.test/install")).toHaveStyle({
      color: "#FFFFFF",
    });
  });

  it("provides one responsive detail gutter and canvas rhythm", async () => {
    const screen = await render(
      <ManagementDetailScroll density="medium" testID="detail-scroll">
        <ManagementDetailCanvas testID="detail-canvas">
          <Text>详情</Text>
        </ManagementDetailCanvas>
      </ManagementDetailScroll>,
    );

    expect(screen.getByTestId("detail-scroll-content")).toHaveStyle({
      paddingHorizontal: 24,
    });
    expect(screen.getByTestId("detail-canvas")).toHaveStyle({
      gap: 24,
      maxWidth: 960,
      paddingVertical: 24,
    });
  });

  it("keeps segmented choices semantic across hover, selection and disabled states", async () => {
    const onPress = jest.fn();
    const screen = await render(
      <SelectionGroup>
        <SelectionButton
          accessibilityLabel="选择自动回复"
          label="自动回复"
          onPress={onPress}
          selected
          testID="selected-choice"
        />
        <SelectionButton
          accessibilityLabel="选择仅提及"
          label="仅提及"
          onPress={onPress}
          testID="idle-choice"
        />
        <SelectionButton
          accessibilityLabel="不可选择"
          disabled
          label="不可选择"
          onPress={onPress}
          testID="disabled-choice"
        />
      </SelectionGroup>,
    );

    expect(screen.getByTestId("selected-choice")).toHaveStyle({
      backgroundColor: "#EAF4FF",
      borderColor: "rgba(0, 111, 238, 0.22)",
      borderRadius: 10,
      minHeight: 48,
    });
    await fireEvent(screen.getByTestId("idle-choice"), "hoverIn");
    expect(screen.getByTestId("idle-choice")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.interactiveHoverSurface,
    });
    expect(screen.getByTestId("disabled-choice")).toHaveStyle({opacity: 0.5});
  });

  it("provides compact text tabs for page modes", async () => {
    const onPress = jest.fn();
    const screen = await render(
      <ManagementTabBar testID="mode-tabs">
        <ManagementTab label="任务" onPress={onPress} selected testID="tasks-tab" />
        <ManagementTab label="提醒" onPress={onPress} testID="reminders-tab" />
      </ManagementTabBar>,
    );

    expect(screen.getByTestId("mode-tabs")).toHaveStyle({
      borderBottomWidth: 1,
      flexDirection: "row",
    });
    expect(screen.getByTestId("tasks-tab")).toHaveStyle({
      borderBottomWidth: 2,
      borderRadius: 0,
      minHeight: 48,
    });
    fireEvent.press(screen.getByTestId("reminders-tab"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("uses a plain detail heading and vertical resource metadata", async () => {
    const screen = await render(
      <>
        <DetailHeading
          metadata={["@research", "Codex"]}
          status={{label: "运行中", tone: "positive"}}
          testID="detail-heading"
          title="研究助手"
        />
        <ResourceMetadataList
          items={[
            {label: "身份", value: "Agent"},
            {label: "消息", value: "已连接"},
          ]}
          testID="resource-metadata"
        />
      </>,
    );

    expect(screen.getByTestId("detail-heading")).toHaveStyle({
      borderBottomWidth: 1,
      flexDirection: "row",
    });
    expect(screen.getByTestId("resource-metadata")).toHaveStyle({
      flexDirection: "column",
    });
    expect(screen.getByText("@research · Codex")).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
  });

  it("keeps empty states terse without an icon card and centers the recovery action", async () => {
    const screen = await render(
      <InlineEmptyState
        actionLabel="新建 Agent"
        description="创建后即可开始协作。"
        icon={RefreshCw}
        onAction={() => undefined}
        testID="agent-empty"
        title="还没有 Agent"
      />,
    );

    expect(screen.getByTestId("agent-empty-icon")).toHaveStyle({
      backgroundColor: "transparent",
      borderRadius: 0,
    });
    expect(screen.getByTestId("agent-empty-action")).toHaveStyle({
      alignItems: "center",
    });
  });

  it("keeps panes and ordinary detail sections flat while ordinary actions stay non-pill", async () => {
    const screen = await render(
      <ManagementStage testID="stage">
        <ManagementHeader eyebrow="SERVER / TASKS" title="任务" />
        <ManagementCollectionPane testID="collection">
          <CollectionRow onPress={() => undefined} selected testID="row">
            <Text>任务一</Text>
          </CollectionRow>
        </ManagementCollectionPane>
        <DetailSection grow span="major" testID="section">
          <StatusIndicator label="在线" tone="positive" />
          <ActionButton importance="primary" label="保存" onPress={() => undefined} testID="action" />
          <ActionButton
            disabled
            importance="primary"
            label="不可用"
            onPress={() => undefined}
            testID="disabled-action"
          />
          <ActionButton
            importance="secondary"
            label="次级操作"
            onPress={() => undefined}
            testID="secondary-action"
          />
          <ActionButton
            context="header"
            importance="tonal"
            label="新建"
            onPress={() => undefined}
            testID="header-action"
          />
          <IconActionButton
            accessibilityLabel="刷新"
            context="header"
            icon={RefreshCw}
            onPress={() => undefined}
            testID="icon-action"
          />
          <ResourceActionRow
            action={<ActionButton importance="secondary" label="执行" onPress={() => undefined} />}
            description="执行一项资源操作。"
            testID="resource-action-row"
            title="资源操作"
          />
        </DetailSection>
      </ManagementStage>,
    );

    expect(screen.getByTestId("stage")).toHaveStyle({
      borderRadius: 0,
    });
    expect(screen.getByTestId("collection")).toHaveStyle({
      borderRadius: 0,
      width: 312,
    });
    expect(screen.getByTestId("row")).toHaveStyle({
      borderRadius: 8,
      gap: 8,
      minHeight: velaTheme.recipes.managementWorkspace.rowMinHeight,
    });
    expect(screen.getByTestId("section")).toHaveStyle({
      borderRadius: 0,
      borderTopWidth: 1,
      flexGrow: 3,
      paddingHorizontal: 0,
      paddingVertical: 20,
    });
    expect(screen.getByTestId("action")).toHaveStyle({
      alignSelf: "flex-start",
      borderRadius: 10,
      minHeight: velaTheme.recipes.managementWorkspace.actionHeight,
    });
    expect(screen.getByTestId("disabled-action")).toHaveStyle({
      opacity: 0.5,
    });
    await fireEvent(screen.getByTestId("action"), "hoverIn");
    expect(screen.getByTestId("action")).toHaveStyle({
      backgroundColor: "#005BC4",
      borderColor: "#005BC4",
    });
    await fireEvent(screen.getByTestId("action"), "hoverOut");
    await fireEvent(screen.getByTestId("secondary-action"), "hoverIn");
    expect(screen.getByTestId("secondary-action")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.actionSecondaryHoverSurface,
    });
    expect(screen.getByTestId("header-action")).toHaveStyle({
      backgroundColor: "#EAF4FF",
      borderColor: "#EAF4FF",
      minHeight: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.getByTestId("icon-action")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      borderRadius: velaTheme.semantic.radius.compactControl,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
      width: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.getByTestId("resource-action-row")).toHaveStyle({
      borderTopWidth: 1,
      minHeight: 72,
    });
  });

  it("provides one responsive resource identity header for Computer and Agent", async () => {
    const screen = await render(
      <>
        <ResourceIdentityHeader
          icon={RefreshCw}
          metadata={["macOS", "最近连接 2 分钟前"]}
          status={{label: "在线", tone: "positive"}}
          testID="computer-identity"
          title="开发机"
        />
        <ResourceIdentityHeader
          identityKind="agent"
          metadata={["@delivery"]}
          monogram="D"
          status={{label: "运行中", tone: "positive"}}
          testID="agent-identity"
          title="交付助手"
        />
      </>,
    );

    expect(screen.getByTestId("computer-identity")).toHaveStyle({
      borderBottomWidth: 0,
      flexDirection: "row",
      flexWrap: "wrap",
      paddingBottom: 20,
    });
    expect(screen.getByTestId("computer-identity-mark")).toHaveStyle({
      borderRadius: 10,
      height: 48,
      width: 48,
    });
    expect(screen.getByTestId("computer-identity-title")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.pageTitle.fontSize,
      lineHeight: velaTheme.semantic.typography.pageTitle.lineHeight,
    });
    expect(screen.getByTestId("computer-identity-metadata")).toHaveTextContent(
      "macOS · 最近连接 2 分钟前",
    );
    expect(screen.getByTestId("agent-identity-mark")).toHaveTextContent("D");
    expect(screen.getByTestId("agent-identity-mark")).toHaveStyle({
      backgroundColor: "#17C964",
    });
  });

  it("provides one flat fact strip for resource metadata", async () => {
    const screen = await render(
      <ResourceFactStrip
        facts={[
          {label: "身份", value: "自然人"},
          {label: "消息", value: "已连接"},
          {label: "状态", value: "正常"},
        ]}
        testID="resource-facts"
      />,
    );

    expect(screen.getByTestId("resource-facts")).toHaveStyle({
      backgroundColor: "#FFFFFF",
      borderBottomWidth: 1,
      borderTopWidth: 1,
      flexDirection: "row",
      flexWrap: "wrap",
    });
    expect(screen.getByTestId("resource-facts-item-0")).toHaveStyle({
      minHeight: 64,
      minWidth: 140,
      paddingHorizontal: velaTheme.spacing.lg,
      paddingVertical: velaTheme.spacing.md,
    });
    expect(screen.getByText("自然人")).toBeTruthy();
  });

  it("provides one record header for task and reminder details", async () => {
    const screen = await render(
      <RecordIdentityHeader
        reference="TASK #12"
        status={{label: "进行中", tone: "info"}}
        testID="record-identity"
        title="首次协作闭环验收"
      />,
    );

    expect(screen.getByTestId("record-identity")).toHaveStyle({
      borderBottomWidth: 0,
      flexDirection: "row",
      flexWrap: "wrap",
      paddingBottom: 20,
    });
    expect(screen.getByTestId("record-identity-title")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.detailTitle.fontSize,
      lineHeight: velaTheme.semantic.typography.detailTitle.lineHeight,
    });
    expect(screen.getByTestId("record-identity-status")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.statusInfoSurface,
    });
  });

  it("provides one responsive resource switcher for management screens", async () => {
    type ResourceSwitcherProps = {
      currentAccessibilityLabel: string;
      currentContent: ReactNode;
      expanded: boolean;
      onToggle(): void;
      options: Array<{
        accessibilityLabel: string;
        content: ReactNode;
        id: string;
        onSelect(): void;
      }>;
      testID?: string;
    };
    const ManagementResourceSwitcher = (
      managementWorkspace as unknown as {
        ManagementResourceSwitcher?: ComponentType<ResourceSwitcherProps>;
      }
    ).ManagementResourceSwitcher;
    expect(ManagementResourceSwitcher).toBeDefined();
    if (!ManagementResourceSwitcher) return;
    const onToggle = jest.fn();
    const onSelect = jest.fn();
    const screen = await render(
      <ManagementResourceSwitcher
        currentAccessibilityLabel="切换当前资源"
        currentContent={<Text>当前资源</Text>}
        expanded={false}
        onToggle={onToggle}
        options={[{
          accessibilityLabel: "打开备用资源",
          content: <Text>备用资源</Text>,
          id: "backup",
          onSelect,
        }]}
        testID="resource-switcher"
      />,
    );

    expect(screen.getByTestId("resource-switcher-trigger")).toHaveStyle({
      borderRadius: 10,
      minHeight: velaTheme.recipes.managementWorkspace.switcherTriggerMinHeight,
    });
    await fireEvent(screen.getByTestId("resource-switcher-trigger"), "hoverIn");
    expect(screen.getByTestId("resource-switcher-trigger")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.interactiveHoverSurface,
    });
    await fireEvent(screen.getByTestId("resource-switcher-trigger"), "hoverOut");
    expect(screen.queryByText("备用资源")).toBeNull();
    await fireEvent.press(screen.getByRole("button", {name: "切换当前资源"}));
    expect(onToggle).toHaveBeenCalledTimes(1);

    await screen.rerender(
      <ManagementResourceSwitcher
        currentAccessibilityLabel="切换当前资源"
        currentContent={<Text>当前资源</Text>}
        expanded
        onToggle={onToggle}
        options={[{
          accessibilityLabel: "打开备用资源",
          content: <Text>备用资源</Text>,
          id: "backup",
          onSelect,
        }]}
        testID="resource-switcher"
      />,
    );
    expect(screen.getByTestId("resource-switcher-menu")).toHaveStyle({
      maxHeight: 232,
    });
    await fireEvent.press(screen.getByRole("button", {name: "打开备用资源"}));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("provides one restrained form surface and action row", async () => {
    type FormProps = {children: ReactNode; testID?: string};
    const ManagementForm = (
      managementWorkspace as unknown as {
        ManagementForm?: ComponentType<FormProps>;
      }
    ).ManagementForm;
    const ManagementFormActions = (
      managementWorkspace as unknown as {
        ManagementFormActions?: ComponentType<FormProps>;
      }
    ).ManagementFormActions;
    expect(ManagementForm).toBeDefined();
    expect(ManagementFormActions).toBeDefined();
    if (!ManagementForm || !ManagementFormActions) return;
    const screen = await render(
      <ManagementForm testID="management-form">
        <Text>表单字段</Text>
        <ManagementFormActions testID="management-form-actions">
          <Text>操作</Text>
        </ManagementFormActions>
      </ManagementForm>,
    );

    expect(screen.getByTestId("management-form")).toHaveStyle({
      borderRadius: 16,
      maxWidth: 900,
      padding: velaTheme.spacing.xl,
    });
    expect(screen.getByTestId("management-form-actions")).toHaveStyle({
      flexDirection: "row",
      gap: 8,
      justifyContent: "flex-end",
    });
  });

  it("provides one semantic field and input treatment for every management form", async () => {
    type FieldProps = {
      children: ReactNode;
      error?: string;
      hint?: string;
      label: string;
      layout?: "compact" | "flex" | "stacked";
      testID?: string;
    };
    type InputProps = {
      accessibilityLabel: string;
      invalid?: boolean;
      multiline?: boolean;
      onChangeText(value: string): void;
      testID?: string;
      value: string;
    };
    const ManagementField = (
      managementWorkspace as unknown as {
        ManagementField?: ComponentType<FieldProps>;
      }
    ).ManagementField;
    const ManagementTextInput = (
      managementWorkspace as unknown as {
        ManagementTextInput?: ComponentType<InputProps>;
      }
    ).ManagementTextInput;
    expect(ManagementField).toBeDefined();
    expect(ManagementTextInput).toBeDefined();
    if (!ManagementField || !ManagementTextInput) return;
    const onChangeText = jest.fn();
    const screen = await render(
      <ManagementField
        error="名称不可用"
        hint="2–32 个字符"
        label="显示名称"
        layout="compact"
        testID="management-field"
      >
        <ManagementTextInput
          accessibilityLabel="显示名称"
          invalid
          multiline
          onChangeText={onChangeText}
          testID="management-input"
          value="Agent"
        />
      </ManagementField>,
    );

    expect(screen.getByTestId("management-field")).toHaveStyle({
      gap: 4,
      width: 160,
    });
    expect(screen.getByTestId("management-input")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.fieldSurface,
      borderColor: "rgba(243, 18, 96, 0.58)",
      borderRadius: 10,
      minHeight: 96,
      width: "100%",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("名称不可用");
    fireEvent.changeText(screen.getByTestId("management-input"), "交付助手");
    expect(onChangeText).toHaveBeenCalledWith("交付助手");
  });

  it("provides consistent collection headers and footer actions", async () => {
    type CollectionHeaderProps = {
      eyebrow: string;
      icon: typeof RefreshCw;
      testID?: string;
      title: string;
    };
    type CollectionActionProps = {
      accessibilityLabel?: string;
      icon?: typeof RefreshCw;
      label: string;
      onPress(): void;
      testID?: string;
    };
    const ManagementCollectionHeader = (
      managementWorkspace as unknown as {
        ManagementCollectionHeader?: ComponentType<CollectionHeaderProps>;
      }
    ).ManagementCollectionHeader;
    const ManagementCollectionFooterAction = (
      managementWorkspace as unknown as {
        ManagementCollectionFooterAction?: ComponentType<CollectionActionProps>;
      }
    ).ManagementCollectionFooterAction;
    expect(ManagementCollectionHeader).toBeDefined();
    expect(ManagementCollectionFooterAction).toBeDefined();
    if (!ManagementCollectionHeader || !ManagementCollectionFooterAction) return;
    const onPress = jest.fn();
    const screen = await render(
      <>
        <ManagementCollectionHeader
          eyebrow="HOSTS / 01"
          icon={RefreshCw}
          testID="collection-header"
          title="Computer"
        />
        <ManagementCollectionFooterAction
          icon={RefreshCw}
          label="纳管 Computer"
          onPress={onPress}
          testID="collection-footer-action"
        />
      </>,
    );

    expect(screen.getByTestId("collection-header")).toHaveStyle({
      minHeight: velaTheme.recipes.managementWorkspace.headerHeight,
    });
    expect(screen.getByTestId("collection-header-mark")).toHaveStyle({
      height: 48,
      width: 48,
    });
    expect(screen.getByTestId("collection-footer-action")).toHaveStyle({
      minHeight: velaTheme.recipes.managementWorkspace.collectionActionHeight,
    });
    await fireEvent.press(screen.getByRole("button", {name: "纳管 Computer"}));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
