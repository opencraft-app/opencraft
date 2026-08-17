import type {
  Account,
  Server,
  UpdateServerInput,
} from "@vela/client-core";
import {useEffect, useState} from "react";
import {useWindowDimensions} from "react-native";

import {
  ManagementPreferenceBody,
  ManagementPreferenceFooter,
  ManagementPreferenceMetadataRow,
  ManagementPreferenceRow,
  ManagementPreferenceSection,
  ManagementTextInput,
} from "../components/management-workspace";
import {SystemPage} from "../patterns/system-page";
import {SystemFeedback} from "../primitives/system-feedback";
import type { PlatformFrameProps } from "../layouts/app-frame";
import { ManagementScreenFrame } from "../layouts/management-screen-frame";
import type { WorkspaceSection } from "../layouts/workspace-section";
import {managementSurfaceLayout} from "../management-surface-layout";
import {
  buildManagementShellModel,
  ManagementPresentation,
  type ManagementPageModel,
  type PresentationAction,
  type PresentationField,
} from "../presentation";

export interface ServerSettingsScreenProps {
  canManage: boolean;
  currentAccount?: Account | null;
  error: string | null;
  /**
   * When false, render section body only. Parent WorkspaceChrome owns the
   * shared rail / bottom bar so navigation membership stays stable.
   * Chrome-only callbacks below are unused in that mode.
   */
  framed?: boolean;
  imStatus?: PlatformFrameProps["imStatus"];
  onLogout?: PlatformFrameProps["onLogout"];
  onNavigateSection?(section: WorkspaceSection): void;
  onSave(input: UpdateServerInput): boolean | Promise<boolean>;
  onSelectServer?(serverId: string): void | Promise<void>;
  pendingAction: string | null;
  sectionHref?: PlatformFrameProps["sectionHref"];
  server: Server;
  serverHref?: PlatformFrameProps["serverHref"];
  servers?: Server[];
  viewportWidth?: number;
}

export function ServerSettingsScreen({
  canManage,
  currentAccount,
  error,
  framed = true,
  imStatus,
  onLogout,
  onNavigateSection,
  onSave,
  onSelectServer,
  pendingAction,
  sectionHref,
  server,
  serverHref,
  servers,
  viewportWidth,
}: ServerSettingsScreenProps) {
  const window = useWindowDimensions();
  const resolvedViewportWidth = viewportWidth ?? window.width;
  const {density} = managementSurfaceLayout(resolvedViewportWidth);
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(server.name);
    setDescription(server.description ?? "");
    setSaved(false);
  }, [server.id]);

  const normalizedName = name.trim();
  const normalizedDescription = description.trim();
  const nameError =
    normalizedName.length === 0
      ? "请输入 Server 名称"
      : normalizedName.length > 100
        ? "Server 名称不能超过 100 个字符"
        : null;
  const descriptionError =
    normalizedDescription.length > 1000
      ? "Server 描述不能超过 1000 个字符"
      : null;
  const dirty =
    normalizedName !== server.name ||
    normalizedDescription !== (server.description ?? "");
  const saving = pendingAction === "server:update";

  const submit = async () => {
    if (!canManage || nameError || descriptionError || !dirty) return;
    const success = await onSave({
      description: normalizedDescription,
      name: normalizedName,
    });
    setSaved(success);
  };

  const fields: PresentationField[] = [
    {
      accessibilityLabel: "Server 名称",
      disabled: !canManage || saving,
      error: nameError,
      id: "server-settings-name",
      label: "名称",
      maxLength: 100,
      onChange(value) {
        setName(value);
        setSaved(false);
      },
      value: name,
    },
    {
      accessibilityLabel: "Server 描述",
      disabled: !canManage || saving,
      error: descriptionError,
      hint: "可选，最多 1000 个字符",
      id: "server-settings-description",
      label: "描述",
      maxLength: 1000,
      multiline: true,
      onChange(value) {
        setDescription(value);
        setSaved(false);
      },
      value: description,
    },
  ];
  const saveAction: PresentationAction = {
    disabled:
      !canManage || saving || !dirty || Boolean(nameError) ||
      Boolean(descriptionError),
    id: "server-settings-save",
    kind: "primary",
    label: saving ? "保存中" : "保存",
    run: submit,
  };
  const pageModel: ManagementPageModel = {
    commands: [],
    error: error ?? undefined,
    form: {
      actions: [saveAction],
      fields,
      title: "基本信息",
    },
    header: {
      eyebrow: "Server 管理",
      title: "Server 设置",
    },
    id: "settings",
    shell: buildManagementShellModel({
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "settings",
      canManageServer: canManage,
      currentServerId: server.id,
      ...(onLogout ? {onLogout} : {}),
      onNavigateSection: onNavigateSection ?? (() => undefined),
      onSelectServer: onSelectServer ?? (() => undefined),
      servers: servers ?? [server],
    }),
  };
  const [nameField, descriptionField] = fields;

  const stage = (
    <SystemPage
      contentTestID="server-settings-detail-scroll"
      density={density}
      feedback={(
        <>
          {error ? (
            <SystemFeedback kind="inline" message={error} tone="danger" />
          ) : null}
          {!canManage ? (
            <SystemFeedback
              kind="inline"
              message="只有 Server Owner 或管理员可以修改这些设置"
            />
          ) : null}
        </>
      )}
      testID="server-settings-stage"
      title={pageModel.header.title}
    >
        <ManagementPreferenceBody testID="server-settings-content">
          <ManagementPreferenceSection
            description="修改成员看到的 Server 名称和简介。"
            testID="server-settings-form"
            title="基本信息"
          >
            <ManagementPreferenceRow
              description="显示在侧栏、邀请和成员页面中。"
              error={nameField!.error}
              label={nameField!.label}
              testID="server-settings-name-row"
            >
              <ManagementTextInput
                accessibilityLabel={nameField!.accessibilityLabel}
                editable={!nameField!.disabled}
                invalid={Boolean(nameField!.error)}
                maxLength={nameField!.maxLength}
                onChangeText={nameField!.onChange}
                testID={nameField!.id}
                value={nameField!.value}
              />
            </ManagementPreferenceRow>
            <ManagementPreferenceRow
              description="帮助成员理解这个 Server 的用途。"
              error={descriptionField!.error}
              hint={descriptionField!.hint}
              label={descriptionField!.label}
            >
              <ManagementTextInput
                accessibilityLabel={descriptionField!.accessibilityLabel}
                editable={!descriptionField!.disabled}
                invalid={Boolean(descriptionField!.error)}
                maxLength={descriptionField!.maxLength}
                multiline={descriptionField!.multiline}
                onChangeText={descriptionField!.onChange}
                testID={descriptionField!.id}
                value={descriptionField!.value}
              />
            </ManagementPreferenceRow>
            <ManagementPreferenceFooter
              action={{
                busy: saving,
                disabled: saveAction.disabled,
                label: saveAction.label,
                onPress: saveAction.run,
                testID: saveAction.id,
              }}
              status={saved
                ? "已保存"
                : dirty
                  ? "有未保存的更改"
                  : "更改会应用到所有成员"}
              statusTone={saved ? "positive" : "neutral"}
            />
          </ManagementPreferenceSection>
          <ManagementPreferenceSection
            description="用于链接和系统引用，创建后不可修改。"
            title="标识"
          >
            <ManagementPreferenceMetadataRow label="Slug" value={server.slug} />
            <ManagementPreferenceMetadataRow label="Server ID" value={server.id} />
          </ManagementPreferenceSection>
        </ManagementPreferenceBody>
    </SystemPage>
  );

  return (
    <ManagementPresentation model={pageModel}>
      {(pageModel) => (
        <ManagementScreenFrame
          account={currentAccount}
          activeSection={pageModel.id}
          canManageServer={canManage}
          currentServerId={server.id}
          framed={framed}
          imStatus={imStatus}
          navigation={null}
          onLogout={onLogout}
          onNavigateSection={onNavigateSection ?? (() => undefined)}
          onSelectServer={onSelectServer ?? (() => undefined)}
          sectionHref={sectionHref}
          serverHref={serverHref}
          servers={servers ?? [server]}
          viewportWidth={viewportWidth}
        >
          {stage}
        </ManagementScreenFrame>
      )}
    </ManagementPresentation>
  );
}
