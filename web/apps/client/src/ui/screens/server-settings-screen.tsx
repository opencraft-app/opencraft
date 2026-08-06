import type {
  Account,
  Server,
  UpdateServerInput,
} from "@vela/client-core";
import {useEffect, useState} from "react";

import {
  ActionButton,
  DetailSection,
  InlineFeedback,
  ManagementDetailScroll,
  ManagementField,
  ManagementForm,
  ManagementFormActions,
  ManagementHeader,
  ManagementStage,
  ManagementTextInput,
  ResourceMetadataList,
} from "../components/management-workspace";
import {
  PlatformFrame,
  type PlatformFrameProps,
  type WorkspaceSection,
} from "../layouts/workspace-shell";

export interface ServerSettingsScreenProps {
  canManage: boolean;
  currentAccount?: Account | null;
  error: string | null;
  imStatus?: PlatformFrameProps["imStatus"];
  onLogout?: PlatformFrameProps["onLogout"];
  onNavigateSection(section: WorkspaceSection): void;
  onSave(input: UpdateServerInput): boolean | Promise<boolean>;
  onSelectServer(serverId: string): void | Promise<void>;
  pendingAction: string | null;
  sectionHref?: PlatformFrameProps["sectionHref"];
  server: Server;
  serverHref?: PlatformFrameProps["serverHref"];
  servers: Server[];
  viewportWidth?: number;
}

export function ServerSettingsScreen({
  canManage,
  currentAccount,
  error,
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

  return (
    <PlatformFrame
      account={currentAccount}
      activeSection="settings"
      canManageServer={canManage}
      currentServerId={server.id}
      imStatus={imStatus}
      navigation={null}
      onLogout={onLogout}
      onNavigateSection={onNavigateSection}
      onSelectServer={onSelectServer}
      sectionHref={sectionHref}
      serverHref={serverHref}
      servers={servers}
      viewportWidth={viewportWidth}
    >
      <ManagementStage testID="server-settings-stage">
        <ManagementHeader title="Server 设置" />
        {error ? <InlineFeedback message={error} /> : null}
        {saved && !error ? <InlineFeedback message="Server 设置已保存" /> : null}
        {!canManage ? (
          <InlineFeedback message="只有 Server Owner 或管理员可以修改这些设置" />
        ) : null}
        <ManagementDetailScroll>
          <DetailSection
            description="修改平台内显示的名称和简介。稳定地址不会变化。"
            title="基本信息"
          >
            <ManagementForm testID="server-settings-form">
              <ManagementField error={nameError} label="名称">
                <ManagementTextInput
                  accessibilityLabel="Server 名称"
                  editable={canManage && !saving}
                  invalid={Boolean(nameError)}
                  maxLength={100}
                  onChangeText={(value) => {
                    setName(value);
                    setSaved(false);
                  }}
                  testID="server-settings-name"
                  value={name}
                />
              </ManagementField>
              <ManagementField
                error={descriptionError}
                hint="可选，最多 1000 个字符"
                label="描述"
              >
                <ManagementTextInput
                  accessibilityLabel="Server 描述"
                  editable={canManage && !saving}
                  invalid={Boolean(descriptionError)}
                  maxLength={1000}
                  multiline
                  onChangeText={(value) => {
                    setDescription(value);
                    setSaved(false);
                  }}
                  testID="server-settings-description"
                  value={description}
                />
              </ManagementField>
              <ManagementFormActions>
                <ActionButton
                  busy={saving}
                  disabled={
                    !canManage || saving || !dirty || Boolean(nameError) ||
                    Boolean(descriptionError)
                  }
                  importance="primary"
                  label={saving ? "保存中" : "保存更改"}
                  onPress={() => void submit()}
                  testID="server-settings-save"
                />
              </ManagementFormActions>
            </ManagementForm>
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
    </PlatformFrame>
  );
}
