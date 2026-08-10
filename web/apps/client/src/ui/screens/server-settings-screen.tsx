import type {
  Account,
  Server,
  UpdateServerInput,
} from "@vela/client-core";
import {useEffect, useState} from "react";
import {useWindowDimensions} from "react-native";

import {
  ActionButton,
  DetailSection,
  InlineFeedback,
  ManagementDetailScroll,
  ManagementField,
  ManagementFormActions,
  ManagementHeader,
  ManagementStage,
  ManagementTextInput,
  ResourceMetadataList,
} from "../components/management-workspace";
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
    label: saving ? "保存中" : "保存更改",
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
    <ManagementStage testID="server-settings-stage">
      <ManagementHeader title={pageModel.header.title} />
      {error ? <InlineFeedback message={error} /> : null}
      {saved && !error ? <InlineFeedback message="Server 设置已保存" /> : null}
      {!canManage ? (
        <InlineFeedback message="只有 Server Owner 或管理员可以修改这些设置" />
      ) : null}
      <ManagementDetailScroll
        density={density}
        testID="server-settings-detail-scroll"
      >
        <DetailSection
          description="修改平台内显示的名称和简介。稳定地址不会变化。"
          testID="server-settings-form"
          title="基本信息"
        >
          <ManagementField error={nameField!.error} label={nameField!.label}>
            <ManagementTextInput
              accessibilityLabel={nameField!.accessibilityLabel}
              editable={!nameField!.disabled}
              invalid={Boolean(nameField!.error)}
              maxLength={nameField!.maxLength}
              onChangeText={nameField!.onChange}
              testID={nameField!.id}
              value={nameField!.value}
            />
          </ManagementField>
          <ManagementField
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
          </ManagementField>
          <ManagementFormActions>
            <ActionButton
              busy={saving}
              disabled={saveAction.disabled}
              importance="primary"
              label={saveAction.label}
              onPress={saveAction.run}
              testID={saveAction.id}
            />
          </ManagementFormActions>
        </DetailSection>
        <DetailSection title="稳定标识">
          <ResourceMetadataList
            items={[
              {label: "Slug", value: server.slug},
              {label: "Server ID", value: server.id},
            ]}
          />
        </DetailSection>
      </ManagementDetailScroll>
    </ManagementStage>
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
