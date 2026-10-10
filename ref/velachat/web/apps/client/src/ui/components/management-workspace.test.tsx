import {fireEvent, render} from "@testing-library/react-native";
import {Text} from "react-native";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import type {ComponentType, ReactNode} from "react";

import * as managementWorkspace from "./management-workspace";

import {
  CollectionIdentityMark,
  CollectionRow,
  CodeBlock,
  DetailHeading,
  DetailSection,
  InlineEmptyState,
  ManagementCollectionPane,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementFormFooter,
  ManagementStageFill,
  ManagementHeader,
  NoticeBanner,
  RecordIdentityHeader,
  ResourceFactStrip,
  ResourceIdentityHeader,
  ResourceMetadataList,
  ManagementStage,
  ResourceActionRow,
  StatusIndicator,
} from "./management-workspace";
import {velaTheme} from "../tokens";
import {SystemButton, SystemIconButton} from "../primitives/system-button";

describe("management workspace primitives", () => {
  it("provides the complete semantic primitive set", () => {
    expect([
      SystemButton,
      CollectionIdentityMark,
      CollectionRow,
      CodeBlock,
      DetailHeading,
      DetailSection,
      SystemIconButton,
      InlineEmptyState,
      ManagementCollectionPane,
      ManagementDetailCanvas,
      ManagementDetailScroll,
      ManagementStageFill,
      ManagementHeader,
      NoticeBanner,
      RecordIdentityHeader,
      ResourceFactStrip,
      ResourceIdentityHeader,
      ResourceMetadataList,
      managementWorkspace.ManagementResourceSelect,
      ManagementStage,
      ResourceActionRow,
      StatusIndicator,
    ]).not.toContain(undefined);
    const publicSurface = managementWorkspace as Record<string, unknown>;
    expect(publicSurface.SelectionButton).toBeUndefined();
    expect(publicSurface.SelectionGroup).toBeUndefined();
    expect(publicSurface.ManagementTab).toBeUndefined();
    expect(publicSurface.ManagementTabBar).toBeUndefined();
    expect(publicSurface.ManagementChoiceField).toBeUndefined();
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
      backgroundColor: "transparent",
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
      borderRadius: velaTheme.semantic.radius.control,
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
      maxWidth: velaTheme.recipes.managementWorkspace.contentMaxWidth,
      paddingVertical: 24,
    });
  });

  it("provides one ordered form footer", async () => {
    const onBack = jest.fn();
    const onSubmit = jest.fn();
    const screen = await render(
      <ManagementFormFooter
        backAction={{label: "上一步", onPress: onBack}}
        flowAction={{
          busy: true,
          disabled: true,
          intent: "advance",
          label: "继续",
          onPress: onSubmit,
          testID: "wizard-advance",
        }}
        testID="wizard-footer"
      />,
    );

    await fireEvent.press(screen.getByText("上一步"));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByText("继续").parent?.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    expect(screen.getByTestId("wizard-advance")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.actionSecondarySurface,
      borderColor: velaTheme.semantic.color.borderControl,
    });
  });

  it("keeps final form submission on the same neutral action model", async () => {
    const screen = await render(
      <ManagementFormFooter
        flowAction={{
          intent: "submit",
          label: "创建 Agent",
          onPress: () => undefined,
          testID: "wizard-submit",
        }}
      />,
    );

    expect(screen.getByTestId("wizard-submit")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.actionSecondarySurface,
      borderColor: velaTheme.semantic.color.borderControl,
    });
  });

  it("keeps a single-line field inside the exact density box", async () => {
    const screen = await render(
      <managementWorkspace.ManagementTextInput
        accessibilityLabel="名称"
        onChangeText={() => undefined}
        testID="single-line-field"
        value="Vela"
      />,
    );

    expect(screen.getByTestId("single-line-field")).toHaveStyle({
      height: velaTheme.recipes.control.fieldHeight,
      minHeight: velaTheme.recipes.control.fieldHeight,
      paddingVertical: 0,
    });
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

  it("keeps empty states terse, left aligned and free of nested cards", async () => {
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
      height: velaTheme.recipes.iconControl.compactSize,
      width: velaTheme.recipes.iconControl.compactSize,
    });
    expect(screen.getByTestId("agent-empty-action")).toHaveStyle({
      flexDirection: "row",
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
        <DetailSection testID="section">
          <StatusIndicator label="在线" tone="positive" />
          <SystemButton variant="standard" label="保存" onPress={() => undefined} testID="action" />
          <SystemButton
            disabled
            variant="standard"
            label="不可用"
            onPress={() => undefined}
            testID="disabled-action"
          />
          <SystemButton
            variant="standard"
            label="次级操作"
            onPress={() => undefined}
            testID="secondary-action"
          />
          <SystemButton
            variant="toolbar"
            label="新建"
            onPress={() => undefined}
            testID="header-action"
          />
          <SystemIconButton
            accessibilityLabel="刷新"
            icon={RefreshCw}
            onPress={() => undefined}
            testID="icon-action"
          />
          <ResourceActionRow
            action={<SystemButton variant="standard" label="执行" onPress={() => undefined} />}
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
      borderRadius: velaTheme.semantic.radius.compactControl,
      gap: 8,
      minHeight: velaTheme.recipes.control.rowHeight,
    });
    expect(screen.getByTestId("section")).toHaveStyle({
      gap: velaTheme.spacing.sm,
    });
    expect(screen.getByTestId("section-body")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.sectionSurface,
      borderRadius: velaTheme.semantic.radius.control,
      borderWidth: 1,
      paddingHorizontal: velaTheme.spacing.lg,
      paddingVertical: velaTheme.recipes.managementWorkspace.sectionPadding,
    });
    expect(screen.getByTestId("action")).toHaveStyle({
      alignSelf: "flex-start",
      borderRadius: velaTheme.semantic.radius.control,
      height: velaTheme.recipes.control.height,
    });
    expect(screen.getByTestId("disabled-action")).toHaveStyle({
      opacity: 0.5,
    });
    await fireEvent(screen.getByTestId("action"), "hoverIn");
    expect(screen.getByTestId("action")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.interactiveHoverSurface,
      borderColor: velaTheme.semantic.color.borderControl,
    });
    await fireEvent(screen.getByTestId("action"), "hoverOut");
    await fireEvent(screen.getByTestId("secondary-action"), "hoverIn");
    expect(screen.getByTestId("secondary-action")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.actionSecondaryHoverSurface,
    });
    expect(screen.getByTestId("header-action")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      borderColor: velaTheme.semantic.color.borderTransparent,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.getByTestId("icon-action")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      borderRadius: velaTheme.semantic.radius.compactControl,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
      width: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.getByTestId("resource-action-row")).toHaveStyle({
      borderTopWidth: 1,
      minHeight: velaTheme.recipes.managementWorkspace.resourceActionMinHeight,
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
      borderRadius: velaTheme.semantic.radius.control,
      height: velaTheme.recipes.resourceIdentity.markSize,
      width: velaTheme.recipes.resourceIdentity.markSize,
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
      minHeight: velaTheme.recipes.resourceIdentity.factMinHeight,
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

  it("provides one responsive resource select for management screens", async () => {
    type ResourceSelectProps = {
      accessibilityLabel: string;
      currentContent: ReactNode;
      onChange(value: string): void;
      onOpenChange(open: boolean): void;
      open: boolean;
      options: Array<{
        accessibilityLabel: string;
        label: string;
        value: string;
      }>;
      testID?: string;
      value: string;
    };
    const ManagementResourceSelect = (
      managementWorkspace as unknown as {
        ManagementResourceSelect?: ComponentType<ResourceSelectProps>;
      }
    ).ManagementResourceSelect;
    expect(ManagementResourceSelect).toBeDefined();
    if (!ManagementResourceSelect) return;
    const onChange = jest.fn();
    const onOpenChange = jest.fn();
    const screen = await render(
      <ManagementResourceSelect
        accessibilityLabel="切换当前资源"
        currentContent={<Text>当前资源</Text>}
        onChange={onChange}
        onOpenChange={onOpenChange}
        open={false}
        options={[{
          accessibilityLabel: "打开备用资源",
          label: "备用资源",
          value: "backup",
        }]}
        testID="resource-switcher"
        value="current"
      />,
    );

    expect(screen.getByTestId("resource-switcher-trigger")).toHaveStyle({
      borderRadius: velaTheme.semantic.radius.control,
      minHeight: velaTheme.recipes.managementWorkspace.switcherTriggerMinHeight,
    });
    await fireEvent(screen.getByTestId("resource-switcher-trigger"), "hoverIn");
    expect(screen.getByTestId("resource-switcher-trigger")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.interactiveHoverSurface,
    });
    await fireEvent(screen.getByTestId("resource-switcher-trigger"), "hoverOut");
    expect(screen.queryByText("备用资源")).toBeNull();
    await fireEvent.press(screen.getByRole("button", {name: "切换当前资源"}));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    await screen.rerender(
      <ManagementResourceSelect
        accessibilityLabel="切换当前资源"
        currentContent={<Text>当前资源</Text>}
        onChange={onChange}
        onOpenChange={onOpenChange}
        open
        options={[{
          accessibilityLabel: "打开备用资源",
          label: "备用资源",
          value: "backup",
        }]}
        testID="resource-switcher"
        value="current"
      />,
    );
    await fireEvent.press(screen.getByLabelText("打开备用资源"));
    expect(onChange).toHaveBeenCalledWith("backup");
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
      borderRadius: velaTheme.semantic.radius.control,
      maxWidth: velaTheme.recipes.managementWorkspace.formMaxWidth,
      padding: velaTheme.spacing.lg,
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
      borderRadius: velaTheme.semantic.radius.control,
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
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      minHeight: velaTheme.recipes.desktopWorkspace.headerHeight,
    });
    expect(screen.getByTestId("collection-header-mark")).toHaveStyle({
      height: velaTheme.semantic.icon.size.large,
      width: velaTheme.semantic.icon.size.large,
    });
    expect(screen.getByTestId("collection-footer-action")).toHaveStyle({
      minHeight: velaTheme.recipes.managementWorkspace.collectionActionHeight,
    });
    await fireEvent.press(screen.getByRole("button", {name: "纳管 Computer"}));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
