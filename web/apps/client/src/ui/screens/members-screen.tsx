import {
  memberCanManageServer,
  selectCurrentHumanMember,
  type AcceptedResource,
  type CreateInviteInput,
  type Invite,
  type InviteSecret,
  type Member,
  type Server,
  type UpdateMemberInput,
} from "@vela/client-core";
import { useMemo, useState } from "react";
import {
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import UsersRound from "lucide-react-native/icons/users-round";
import X from "lucide-react-native/icons/x";

import {deviceTimezone, normalizeLocalDateTime} from "../date-time";
import {InviteExpirationField} from "../components/invite-expiration-field";
import {
  createInviteExpirationSession,
  type InviteExpirationSession,
} from "../components/invite-expiration";
import {ManagementEmptyState} from "../components/management-empty-state";
import {memberEmptyCopy} from "../management-empty-copy";
import {
  buildManagementShellModel,
  ManagementPresentation,
  type ManagementPageModel,
  type PresentationAction,
  type PresentationForm,
} from "../presentation";
import {
  CollectionIdentityMark,
  CollectionRow,
  CollectionRowCopy,
  DetailSection,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementField,
  ManagementForm,
  ManagementFormFooter,
  ManagementHeader,
  ManagementHeaderActions,
  ManagementResourceDirectory,
  ManagementResourceSelect,
  ManagementStage,
  ManagementTextInput,
  ResourceActionRow,
  ResourceIdentityHeader,
  ResourceMetadataList,
} from "../components/management-workspace";
import {SystemButton, SystemIconButton} from "../primitives/system-button";
import {SystemFeedback} from "../primitives/system-feedback";
import {SystemSegmentedControl} from "../primitives/system-segmented-control";
import {SystemDialog} from "../primitives/system-dialog";
import {
  OperationStatusList,
  type OperationStatusItem,
} from "../components/operation-status-list";
import { ManagementScreenFrame } from "../layouts/management-screen-frame";
import type { PlatformFrameProps } from "../layouts/app-frame";
import type { WorkspaceSection } from "../layouts/workspace-section";
import { managementSurfaceLayout } from "../management-surface-layout";
import {memberListItemViewModel} from "../presentation/resources/member";
import {
  memberImStateLabel,
  memberKindLabel,
  memberRoleLabel,
  memberStatusLabel,
  visibleMemberHandle,
} from "../member-identity";

export interface MembersScreenProps {
  accountId: string;
  currentAccount?: PlatformFrameProps["account"];
  currentServerId: string | null;
  error: string | null;
  /**
   * When false, render section body only. Parent WorkspaceChrome owns the
   * shared rail / bottom bar so navigation membership stays stable.
   */
  framed?: boolean;
  invites: Invite[];
  imStatus?: PlatformFrameProps["imStatus"];
  loading: boolean;
  members: Member[];
  onAcceptInvite(
    token: string,
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onContinueOperation?(operationId: string): void | Promise<void>;
  onCreateInvite(
    input: CreateInviteInput,
  ): InviteSecret | null | Promise<InviteSecret | null>;
  onLogout?: PlatformFrameProps["onLogout"];
  onNavigateSection(section: WorkspaceSection): void;
  onRefresh(): void | Promise<void>;
  onRemoveMember(memberId: string): void | Promise<void>;
  onRevokeInvite(inviteId: string): void | Promise<void>;
  onSelectServer(serverId: string): void | Promise<void>;
  onUpdateMember(
    memberId: string,
    input: UpdateMemberInput,
  ): void | Promise<void>;
  pendingAction: string | null;
  operations?: OperationStatusItem[];
  sectionHref?: PlatformFrameProps["sectionHref"];
  serverHref?: PlatformFrameProps["serverHref"];
  servers: Server[];
  viewportWidth?: number;
}

export function MembersScreen(props: MembersScreenProps) {
  const {
    accountId,
    currentAccount,
    currentServerId,
    error,
    framed = true,
    invites,
    imStatus,
    loading,
    members,
    onAcceptInvite,
    onContinueOperation = () => undefined,
    onCreateInvite,
    onLogout,
    onNavigateSection,
    onRefresh,
    onRemoveMember,
    onRevokeInvite,
    onSelectServer,
    onUpdateMember,
    pendingAction,
    operations = [],
    sectionHref,
    serverHref,
    servers,
    viewportWidth,
  } = props;
  const window = useWindowDimensions();
  const resolvedViewportWidth = viewportWidth ?? window.width;
  const surface = managementSurfaceLayout(resolvedViewportWidth);
  const {density, phone, stackedCollection} = surface;
  const showStackedCollection = stackedCollection && members.length > 1;
  const [acceptToken, setAcceptToken] = useState("");
  const [acceptingInvite, setAcceptingInvite] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] =
    useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [inviteExpirationSession, setInviteExpirationSession] =
    useState<InviteExpirationSession | null>(null);
  const [inviteMaxUses, setInviteMaxUses] = useState("1");
  const [inviteRole, setInviteRole] = useState<Invite["role"]>("member");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [inviteSecret, setInviteSecret] =
    useState<InviteSecret | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<
    string | null
  >(members[0]?.id ?? null);
  const beginInviteCreation = () => {
    const session = createInviteExpirationSession(
      new Date(Date.now()),
      deviceTimezone(),
    );
    setInviteExpirationSession(session);
    setInviteExpiresAt(session.value);
    setCreatingInvite(true);
  };
  const selected = useMemo(
    () =>
      members.find((item) => item.id === selectedMemberId) ??
      members[0] ??
      null,
    [members, selectedMemberId],
  );
  const selectedVisibleHandle = selected
    ? visibleMemberHandle(selected)
    : null;
  const memberItems = members.map(member => ({
    resource: member,
    view: memberListItemViewModel(member, member.id === selected?.id),
  }));
  const currentMember = selectCurrentHumanMember(members, {accountId});
  const canManage = memberCanManageServer(currentMember);
  const submitInvite = async (input: CreateInviteInput) => {
    const secret = await onCreateInvite(input);
    if (secret) setInviteSecret(secret);
    setCreatingInvite(false);
    setInviteExpiresAt("");
    setInviteExpirationSession(null);
    setInviteMaxUses("1");
    setInviteRole("member");
  };
  const cancelInvite = () => {
    setCreatingInvite(false);
    setInviteExpiresAt("");
    setInviteExpirationSession(null);
    setInviteMaxUses("1");
    setInviteRole("member");
  };
  const normalizedInviteExpiresAt = normalizeLocalDateTime(
    inviteExpiresAt,
    deviceTimezone(),
  );
  const inviteExpiresAtError = inviteExpiresAt.trim()
    ? validateInviteExpiration(normalizedInviteExpiresAt)
    : null;
  const inviteMaxUsesError = validateInviteMaxUses(inviteMaxUses);
  const inviteFormValid =
    inviteExpiresAt.trim().length > 0 &&
    !inviteExpiresAtError &&
    !inviteMaxUsesError;

  const desktopNavigation = (
    <ManagementResourceDirectory
      eyebrow={`${members.length} 位成员`}
      horizontal={stackedCollection}
      icon={UsersRound}
      testID="member-sidebar"
      title="成员"
    >
      {memberItems.map(({resource: member, view}) => {
        return (
          <CollectionRow
            accessibilityLabel={view.accessibilityLabel}
            key={view.id}
            onPress={() => setSelectedMemberId(member.id)}
            orientation={stackedCollection ? "horizontal" : "vertical"}
            selected={view.selected}
          >
            <CollectionIdentityMark
              identityKind={member.kind}
              monogram={member.displayName.slice(0, 1)}
            />
            <CollectionRowCopy
              meta={view.meta}
              title={view.title}
            />
          </CollectionRow>
        );
      })}
    </ManagementResourceDirectory>
  );
  const mobileNavigation = selected ? (
    <ManagementResourceSelect
      accessibilityLabel={`切换成员，当前 ${selected.displayName}${selectedVisibleHandle ? ` @${selectedVisibleHandle}` : ""}`}
      currentContent={(
        <>
        <CollectionIdentityMark
          identityKind={selected.kind}
          monogram={selected.displayName.slice(0, 1)}
        />
        <CollectionRowCopy
          meta={`${selectedVisibleHandle ? `@${selectedVisibleHandle} · ` : ""}${memberKindLabel[selected.kind]} · ${memberRoleLabel[selected.role]}`}
          numberOfLines={1}
          title={selected.displayName}
        />
        </>
      )}
      onChange={setSelectedMemberId}
      onOpenChange={setSwitcherOpen}
      open={switcherOpen}
      options={memberItems.map(({resource: member, view}) => {
          return {
            accessibilityLabel: view.accessibilityLabel,
            label: view.title,
            value: member.id,
          };
        })}
      testID="member-mobile-switcher"
      value={selected.id}
    />
  ) : null;

  const createInviteAction: PresentationAction = {
    disabled: !canManage || pendingAction !== null,
    id: "create-invite",
    kind: "primary",
    label: "创建邀请",
    run: beginInviteCreation,
    shortcut: "N",
  };
  const acceptInviteAction: PresentationAction = {
    disabled: pendingAction !== null,
    id: "accept-invite",
    label: "接受邀请",
    run: () => setAcceptingInvite(true),
  };
  const selectedActions: PresentationAction[] = selected && canManage &&
    selected.kind === "human" && selected.role !== "owner"
    ? [
        {
          disabled: pendingAction !== null,
          id: "toggle-member-role",
          kind: "primary",
          label: selected.role === "admin" ? "设为普通成员" : "设为管理员",
          run: () => onUpdateMember(selected.id, {
            role: selected.role === "admin" ? "member" : "admin",
          }),
        },
        ...(confirmRemoveId === selected.id
          ? [
              {
                id: "cancel-remove-member",
                label: "取消移除",
                run: () => setConfirmRemoveId(null),
              },
              {
                disabled: pendingAction !== null,
                id: "confirm-remove-member",
                kind: "danger" as const,
                label: `确认移除 ${selected.displayName}`,
                run: async () => {
                  await onRemoveMember(selected.id);
                  setConfirmRemoveId(null);
                },
              },
            ]
          : [{
              id: "remove-member",
              kind: "danger" as const,
              label: "移除成员",
              run: () => setConfirmRemoveId(selected.id),
            }]),
      ]
    : [];
  const semanticModel = (): ManagementPageModel => ({
    collection: {
      items: memberItems.map(({resource, view}) => ({
        ...view,
        onSelect: () => setSelectedMemberId(resource.id),
      })),
      label: "成员",
    },
    commands: [
      ...(canManage ? [createInviteAction] : []),
      acceptInviteAction,
      {
        disabled: loading,
        id: "refresh-members",
        label: "刷新成员",
        run: onRefresh,
        shortcut: "R",
      },
      ...invites.map(invite => ({
        disabled: pendingAction !== null,
        id: `revoke-invite-${invite.id}`,
        kind: "danger" as const,
        label: `撤销邀请 ${invite.id}`,
        run: () => onRevokeInvite(invite.id),
      })),
    ],
    ...(creatingInvite
      ? {
          form: {
            actions: [
              {
                id: "cancel-create-invite",
                label: "取消",
                run: cancelInvite,
              },
              {
                disabled: pendingAction !== null || !inviteFormValid,
                id: "submit-create-invite",
                kind: "primary" as const,
                label: "生成邀请链接",
                run: () => submitInvite({
                  expiresAt: normalizedInviteExpiresAt,
                  maxUses: Number.parseInt(inviteMaxUses, 10),
                  role: inviteRole,
                }),
              },
            ],
            fields: [
              {
                disabled: pendingAction !== null,
                id: "invite-role",
                label: "邀请角色",
                onChange: value => setInviteRole(value as Invite["role"]),
                options: [
                  {label: "普通成员", value: "member"},
                  {label: "管理员", value: "admin"},
                ],
                value: inviteRole,
              },
              {
                disabled: pendingAction !== null,
                error: inviteExpiresAtError,
                id: "invite-expires-at",
                label: "有效期",
                onChange: setInviteExpiresAt,
                placeholder: "例如：2026-08-05 18:00",
                value: inviteExpiresAt,
              },
              {
                disabled: pendingAction !== null,
                error: inviteMaxUsesError,
                id: "invite-max-uses",
                label: "最大使用次数",
                onChange: setInviteMaxUses,
                value: inviteMaxUses,
              },
            ],
            title: "创建邀请",
          },
        }
      : inviteSecret
        ? {
            form: {
              actions: [
                {
                  id: "close-invite-secret",
                  label: "关闭",
                  run: () => setInviteSecret(null),
                },
              ],
              fields: [
                {
                  disabled: true,
                  id: "invite-secret",
                  label: `一次性邀请 · 有效期至 ${inviteSecret.invite.expiresAt}`,
                  multiline: true,
                  onChange: () => undefined,
                  value: inviteSecret.token,
                },
              ],
              title: "邀请已创建",
            },
          }
        : acceptingInvite
          ? {
              form: {
                actions: [
                  {
                    id: "cancel-accept-invite",
                    label: "取消",
                    run: () => setAcceptingInvite(false),
                  },
                  {
                    disabled: pendingAction !== null || acceptToken.trim().length === 0,
                    id: "submit-accept-invite",
                    kind: "primary" as const,
                    label: "接受邀请",
                    run: async () => {
                      const accepted = await onAcceptInvite(acceptToken.trim());
                      if (accepted) {
                        setAcceptToken("");
                        setAcceptingInvite(false);
                      }
                    },
                  },
                ],
                fields: [{
                  disabled: pendingAction !== null,
                  id: "invite-token",
                  label: "邀请 token",
                  onChange: setAcceptToken,
                  placeholder: "粘贴邀请 token",
                  value: acceptToken,
                }],
                title: "接受邀请",
              },
            }
          : selected
            ? {
                detail: {
                  actions: selectedActions,
                  description: `${memberKindLabel[selected.kind]} · ${memberImStateLabel[selected.imState]} · ${memberStatusLabel[selected.status]}`,
                  meta: selectedVisibleHandle ? `@${selectedVisibleHandle}` : undefined,
                  status: memberRoleLabel[selected.role],
                  title: selected.displayName,
                },
              }
            : {
                empty: {
                  action: canManage
                    ? {
                        disabled: pendingAction !== null,
                        id: "create-invite",
                        kind: "primary" as const,
                        label: "创建邀请",
                        run: beginInviteCreation,
                      }
                    : acceptInviteAction,
                  description: memberEmptyCopy.description,
                  title: memberEmptyCopy.title,
                },
              }),
    error: error ?? undefined,
    header: {
      eyebrow: "成员管理",
      summary: `${members.length} 位成员 · ${invites.length} 个邀请`,
      title: creatingInvite
        ? "创建邀请"
        : acceptingInvite
          ? "接受邀请"
          : "成员",
    },
    id: "members",
    shell: buildManagementShellModel({
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "members",
      canManageServer: canManage,
      currentServerId,
      ...(onLogout ? {onLogout} : {}),
      onNavigateSection,
      onSelectServer,
      servers,
    }),
  });

  const navigation = stackedCollection ? null : desktopNavigation;
  const renderStage = (pageModel: ManagementPageModel) => (
      <ManagementStage>
        <ManagementHeader
          actions={(
            <ManagementHeaderActions
              createAccessibilityLabel="创建邀请"
              createIconTestID="member-create-icon"
              createLabel="邀请"
              createVisible={canManage && !creatingInvite}
              onCreate={beginInviteCreation}
              onRefresh={onRefresh}
              refreshAccessibilityLabel="刷新成员"
              refreshDisabled={loading}
              refreshTestID="member-refresh-icon"
            />
          )}
          title={pageModel.header.title}
          titleTestID="member-stage-title"
        />
        {pageModel.error ? (
          <SystemFeedback kind="inline" message={pageModel.error} tone="danger" />
        ) : null}
        {members.length > 1 && !creatingInvite && !acceptingInvite
          ? phone
            ? mobileNavigation
            : showStackedCollection
              ? desktopNavigation
              : null
          : null}
        <ManagementDetailScroll
          density={density}
          testID="member-detail-scroll"
        >
          {operations.length > 0 ? (
            <View style={styles.operationStatus}>
              <OperationStatusList
                items={operations}
                onContinue={onContinueOperation}
              />
            </View>
          ) : null}
          {creatingInvite ? (
            <InviteForm
              form={pageModel.form!}
              session={inviteExpirationSession!}
            />
          ) : null}
          {inviteSecret ? (
            <InviteSecretPanel
              onClose={() => setInviteSecret(null)}
              secret={inviteSecret}
            />
          ) : null}
          {!creatingInvite && !acceptingInvite ? (
            members.length === 0 ? (
              <ManagementEmptyState
                actionAccessibilityLabel={
                  canManage ? "从空状态创建邀请" : "从空状态接受邀请"
                }
                actionLabel={canManage ? "创建邀请" : "使用邀请 token"}
                description={pageModel.empty?.description ?? memberEmptyCopy.description}
                onAction={() => {
                  if (canManage) beginInviteCreation();
                  else setAcceptingInvite(true);
                }}
                title={pageModel.empty?.title ?? memberEmptyCopy.title}
              />
            ) : (
            <ManagementDetailCanvas testID="member-detail">
              {selected ? (
                <>
                  <ResourceIdentityHeader
                    identityKind={selected.kind}
                    markTestID="member-hero-avatar"
                    metadata={[
                      ...(selectedVisibleHandle
                        ? [`@${selectedVisibleHandle}`]
                        : []),
                      memberKindLabel[selected.kind],
                    ]}
                    monogram={selected.displayName.slice(0, 1)}
                    status={{label: memberRoleLabel[selected.role]}}
                    testID="member-hero"
                    title={selected.displayName}
                  />
                  <ResourceMetadataList
                    items={[
                      {label: "身份", value: memberKindLabel[selected.kind]},
                      {label: "消息", value: memberImStateLabel[selected.imState]},
                      {label: "状态", value: memberStatusLabel[selected.status]},
                    ]}
                    testID="member-metadata-list"
                  />
                  {canManage &&
                  selected.kind === "human" &&
                  selected.role !== "owner" ? (
                    <View style={styles.memberActions}>
                      <SystemButton
                        accessibilityLabel={
                          selected.role === "admin"
                            ? `将 ${selected.displayName} 设为普通成员`
                            : `将 ${selected.displayName} 设为管理员`
                        }
                        disabled={pendingAction !== null}
                        variant="secondary"
                        label={selected.role === "admin"
                          ? "设为普通成员"
                          : "设为管理员"}
                        onPress={() =>
                          onUpdateMember(selected.id, {
                            role: selected.role === "admin" ? "member" : "admin",
                          })
                        }
                      />
                      <SystemButton
                        accessibilityLabel={`移除成员 ${selected.displayName}`}
                        variant="destructive"
                        label="移除成员"
                        onPress={() => setConfirmRemoveId(selected.id)}
                      />
                    </View>
                  ) : null}
                </>
              ) : null}
              {canManage && invites.length > 0 ? (
                <DetailSection testID="member-invite-list" title="邀请记录">
                  {invites.map((invite) => (
                    <View key={invite.id} style={styles.inviteRow}>
                      <View style={styles.rowCopy}>
                        <Text style={styles.rowTitle}>
                          {memberRoleLabel[invite.role]} · {invite.usedCount}/{invite.maxUses}
                        </Text>
                        <Text style={styles.mono}>
                          {invite.id} · {invite.expiresAt}
                        </Text>
                      </View>
                      <SystemButton
                        accessibilityLabel={`撤销邀请 ${invite.id}`}
                        disabled={pendingAction !== null}
                        variant="destructive"
                        label="撤销"
                        onPress={() => onRevokeInvite(invite.id)}
                      />
                    </View>
                  ))}
                </DetailSection>
              ) : null}
              <ResourceActionRow
                action={(
                  <SystemButton
                    accessibilityLabel="接受其他 Server 邀请"
                    variant="secondary"
                    label="使用邀请 token"
                    onPress={() => setAcceptingInvite(true)}
                  />
                )}
                description="使用其他 Server 发来的一次性邀请。"
                testID="member-join-server"
                title="加入其他 Server"
              />
            </ManagementDetailCanvas>
            )
          ) : null}
          {acceptingInvite ? (
            <ManagementDetailCanvas>
              <DetailSection
                description="粘贴其他 Server 发来的一次性邀请 token。"
                testID="member-accept-invite"
                title="接受邀请"
              >
                <View style={styles.acceptRow}>
                  <ManagementField label="邀请 token" layout="flex">
                    <ManagementTextInput
                      accessibilityLabel="接受邀请 token"
                      autoCapitalize="none"
                      onChangeText={setAcceptToken}
                      placeholder="粘贴邀请 token"
                      value={acceptToken}
                    />
                  </ManagementField>
                  <SystemButton
                    accessibilityLabel="接受邀请"
                    disabled={
                      pendingAction !== null || acceptToken.trim().length === 0
                    }
                    variant="default"
                    label="接受邀请"
                    onPress={async () => {
                      const accepted = await onAcceptInvite(acceptToken.trim());
                      if (accepted) {
                        setAcceptToken("");
                        setAcceptingInvite(false);
                      }
                    }}
                  />
                </View>
                <SystemButton
                  accessibilityLabel="取消接受邀请"
                  variant="secondary"
                  label="取消"
                  onPress={() => setAcceptingInvite(false)}
                />
              </DetailSection>
            </ManagementDetailCanvas>
          ) : null}
        </ManagementDetailScroll>
      </ManagementStage>
  );

  return (
    <ManagementPresentation model={semanticModel}>
      {(pageModel) => (
        <>
          <ManagementScreenFrame
          account={currentAccount}
          activeSection="members"
          canManageServer={canManage}
          currentServerId={currentServerId}
          framed={framed}
          imStatus={imStatus}
          navigation={navigation}
          onLogout={onLogout}
          onNavigateSection={onNavigateSection}
          onSelectServer={onSelectServer}
          sectionHref={sectionHref}
          serverHref={serverHref}
          servers={servers}
          viewportWidth={viewportWidth}
        >
          {renderStage(pageModel)}
          </ManagementScreenFrame>
          {selected && confirmRemoveId === selected.id ? (
            <SystemDialog
              actions={[
                {id: "cancel", intent: "secondary", kind: "cancel", label: "取消"},
                {
                  disabled: pendingAction !== null,
                  id: "confirm",
                  intent: "destructive",
                  kind: "action",
                  label: "确认移除",
                },
              ]}
              busy={pendingAction !== null}
              description="移出后，该成员将无法访问当前 Server；历史消息会保留。"
              dialogId="remove-member-dialog"
              onAction={id => {
                if (id === "confirm") void onRemoveMember(selected.id);
              }}
              onOpenChange={() => setConfirmRemoveId(null)}
              open
              title={`将 ${selected.displayName} 移出 Server？`}
            />
          ) : null}
        </>
      )}
    </ManagementPresentation>
  );
}

function InviteForm({
  form,
  session,
}: {
  form: PresentationForm;
  session: InviteExpirationSession;
}) {
  const role = form.fields.find(field => field.id === "invite-role")!;
  const expiresAt = form.fields.find(field => field.id === "invite-expires-at")!;
  const maxUses = form.fields.find(field => field.id === "invite-max-uses")!;
  const cancel = form.actions.find(action => action.id === "cancel-create-invite")!;
  const submit = form.actions.find(action => action.id === "submit-create-invite")!;
  return (
    <ManagementForm testID="member-invite-form">
      <ManagementField label={role.label}>
        <SystemSegmentedControl
          accessibilityLabel={role.label}
          disabled={role.disabled}
          onChange={role.onChange}
          options={(role.options ?? []).map(option => ({
            ...option,
            accessibilityLabel: option.value === "admin"
              ? "邀请管理员"
              : "邀请普通成员",
          }))}
          value={role.value}
        />
      </ManagementField>
      <View style={styles.formGrid}>
        <InviteExpirationField field={expiresAt} session={session} />
        <ManagementField
          error={maxUses.error}
          hint={maxUses.hint}
          label={maxUses.label}
          layout="compact"
        >
          <ManagementTextInput
            accessibilityLabel={maxUses.accessibilityLabel ?? "邀请最大使用次数"}
            editable={!maxUses.disabled}
            invalid={Boolean(maxUses.error)}
            keyboardType="number-pad"
            onChangeText={maxUses.onChange}
            value={maxUses.value}
          />
        </ManagementField>
      </View>
      <ManagementFormFooter
        cancelAction={{
          accessibilityLabel: "取消创建邀请",
          ...cancel,
          onPress: cancel.run,
        }}
        primaryAction={{
          accessibilityLabel: "生成邀请链接",
          ...submit,
          onPress: submit.run,
        }}
      />
    </ManagementForm>
  );
}

function validateInviteExpiration(value: string): string | null {
  const timestamp = Date.parse(value);
  const ttl = timestamp - Date.now();
  if (
    !Number.isFinite(timestamp) ||
    ttl < 5 * 60_000 ||
    ttl > 30 * 24 * 60 * 60_000
  ) {
    return "有效期需在 5 分钟后至 30 天内。";
  }
  return null;
}

function validateInviteMaxUses(value: string): string | null {
  const trimmed = value.trim();
  const count = Number(trimmed);
  if (!/^\d+$/u.test(trimmed) || !Number.isInteger(count) || count < 1 || count > 1000) {
    return "最大使用次数需为 1–1000 的整数。";
  }
  return null;
}


function InviteSecretPanel({
  onClose,
  secret,
}: {
  onClose(): void;
  secret: InviteSecret;
}) {
  return (
    <View style={styles.secretPanel}>
      <View style={styles.secretHeader}>
        <View style={styles.rowCopy}>
          <Text style={styles.rowTitle}>一次性邀请</Text>
          <Text style={styles.warning}>
            关闭后不再保留，请只发给目标成员。
          </Text>
        </View>
        <SystemIconButton
          accessibilityLabel="关闭一次性邀请"
          icon={X}
          onPress={onClose}
        />
      </View>
      <Text selectable style={styles.secret}>
        {secret.token}
      </Text>
      <Text style={styles.mono}>有效期至 {secret.invite.expiresAt}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  acceptRow: {
    alignItems: "flex-end",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  formGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  inviteRow: {
    alignItems: "center",
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.md,
    justifyContent: "space-between",
    paddingVertical: theme.spacing.sm,
  },
  memberActions: {
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.lg,
  },
  mono: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  operationStatus: {
    paddingHorizontal: theme.spacing.xl,
    paddingTop: theme.spacing.xl,
  },
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    ...theme.semantic.typography.sectionTitle,
  },
  secret: {
    backgroundColor: theme.semantic.color.inverseSurface,
    color: theme.semantic.color.textInverse,
    ...theme.semantic.typography.label,
    borderRadius: theme.semantic.radius.control,
    padding: theme.spacing.md,
  },
  secretHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  secretPanel: {
    backgroundColor: theme.semantic.color.statusInfoSurface,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
  },
  warning: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.label,
  },
}));
