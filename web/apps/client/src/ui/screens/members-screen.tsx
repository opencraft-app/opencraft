import type {
  AcceptedResource,
  CreateInviteInput,
  Invite,
  InviteSecret,
  Member,
  Server,
  UpdateMemberInput,
} from "@vela/client-core";
import { useMemo, useState } from "react";
import {
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Plus from "lucide-react-native/icons/plus";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import UsersRound from "lucide-react-native/icons/users-round";
import X from "lucide-react-native/icons/x";

import {deviceTimezone, normalizeLocalDateTime} from "../date-time";
import { layoutMode } from "../layout-mode";
import {
  ManagementPresentation,
  type ManagementPageModel,
  type PresentationAction,
} from "../presentation";
import {
  ActionButton,
  CollectionRow,
  DetailSection,
  IconActionButton,
  InlineFeedback,
  ManagementCollectionHeader,
  ManagementCollectionPane,
  ManagementDateTimeInput,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementField,
  ManagementForm,
  ManagementFormActions,
  ManagementHeader,
  ManagementResourceSwitcher,
  ManagementStage,
  ManagementTextInput,
  ResourceActionRow,
  ResourceIdentityHeader,
  ResourceMetadataList,
  SelectionButton,
  SelectionGroup,
} from "../components/management-workspace";
import {breakpoints} from "../theme";
import {
  OperationStatusList,
  type OperationStatusItem,
} from "../components/operation-status-list";
import {
  PlatformFrame,
  type PlatformFrameProps,
  type WorkspaceSection,
} from "../layouts/workspace-shell";
import {memberIdentityLabel, visibleMemberHandle} from "../member-identity";

export interface MembersScreenProps {
  accountId: string;
  currentAccount?: PlatformFrameProps["account"];
  currentServerId: string | null;
  error: string | null;
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
  const frameMode = layoutMode(resolvedViewportWidth);
  const compact = frameMode === "compact";
  const medium = frameMode === "medium";
  const phone = resolvedViewportWidth < breakpoints.medium;
  const stackedCollection = compact || medium;
  const showStackedCollection = stackedCollection && members.length > 1;
  const [acceptToken, setAcceptToken] = useState("");
  const [acceptingInvite, setAcceptingInvite] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] =
    useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [inviteMaxUses, setInviteMaxUses] = useState("1");
  const [inviteRole, setInviteRole] = useState<Invite["role"]>("member");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [inviteSecret, setInviteSecret] =
    useState<InviteSecret | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<
    string | null
  >(members[0]?.id ?? null);
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
  const currentMember = members.find(
    (member) =>
      member.kind === "human" && member.accountId === accountId,
  );
  const canManage =
    currentMember?.role === "owner" ||
    currentMember?.role === "admin";
  const submitInvite = async (input: CreateInviteInput) => {
    const secret = await onCreateInvite(input);
    if (secret) setInviteSecret(secret);
    setCreatingInvite(false);
    setInviteExpiresAt("");
    setInviteMaxUses("1");
    setInviteRole("member");
  };
  const cancelInvite = () => {
    setCreatingInvite(false);
    setInviteExpiresAt("");
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
    <ManagementCollectionPane
      orientation={stackedCollection ? "horizontal" : "vertical"}
      testID="member-sidebar"
    >
      {!stackedCollection ? (
        <ManagementCollectionHeader
          eyebrow={`${members.length} 位成员`}
          icon={UsersRound}
          title="成员"
        />
      ) : null}
      <ScrollView
        contentContainerStyle={[
          styles.list,
          stackedCollection && styles.listStacked,
        ]}
        horizontal={stackedCollection}
        showsHorizontalScrollIndicator={false}
        style={styles.listScroller}
      >
        {members.map((member) => {
          const active = member.id === selected?.id;
          const identityLabel = memberIdentityLabel(member);
          return (
            <CollectionRow
              accessibilityLabel={`打开成员 ${member.displayName}${identityLabel ? ` ${identityLabel}` : ""}`}
              key={member.id}
              onPress={() => setSelectedMemberId(member.id)}
              orientation={stackedCollection ? "horizontal" : "vertical"}
              selected={active}
            >
              <View
                style={[
                  styles.avatar,
                  member.kind === "agent" && styles.avatarAgent,
                ]}
              >
                <Text style={styles.avatarText}>
                  {member.displayName.slice(0, 1)}
                </Text>
              </View>
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle}>{member.displayName}</Text>
                <Text style={styles.mono}>
                  {identityLabel ? `${identityLabel} · ` : ""}
                  {memberKindLabel[member.kind]} · {memberRoleLabel[member.role]}
                </Text>
              </View>
            </CollectionRow>
          );
        })}
      </ScrollView>
    </ManagementCollectionPane>
  );
  const mobileNavigation = selected ? (
    <ManagementResourceSwitcher
      currentAccessibilityLabel={`切换成员，当前 ${selected.displayName}${selectedVisibleHandle ? ` @${selectedVisibleHandle}` : ""}`}
      currentContent={(
        <>
        <View
          style={[
            styles.avatar,
            selected.kind === "agent" && styles.avatarAgent,
          ]}
        >
          <Text style={styles.avatarText}>
            {selected.displayName.slice(0, 1)}
          </Text>
        </View>
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {selected.displayName}
          </Text>
          <Text numberOfLines={1} style={styles.mono}>
            {selectedVisibleHandle ? `@${selectedVisibleHandle} · ` : ""}
            {memberKindLabel[selected.kind]} · {memberRoleLabel[selected.role]}
          </Text>
        </View>
        </>
      )}
      expanded={switcherOpen}
      onToggle={() => setSwitcherOpen((current) => !current)}
      options={members
        .filter((member) => member.id !== selected.id)
        .map((member) => {
          const identityLabel = memberIdentityLabel(member);
          return {
            accessibilityLabel: `打开成员 ${member.displayName}${identityLabel ? ` ${identityLabel}` : ""}`,
            content: (
              <>
                <View
                  style={[
                    styles.avatar,
                    member.kind === "agent" && styles.avatarAgent,
                  ]}
                >
                  <Text style={styles.avatarText}>
                    {member.displayName.slice(0, 1)}
                  </Text>
                </View>
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {member.displayName}
                  </Text>
                  <Text numberOfLines={1} style={styles.mono}>
                    {identityLabel ? `${identityLabel} · ` : ""}
                    {memberKindLabel[member.kind]} · {memberRoleLabel[member.role]}
                  </Text>
                </View>
              </>
            ),
            id: member.id,
            onSelect: () => {
              setSelectedMemberId(member.id);
              setSwitcherOpen(false);
            },
          };
        })}
      testID="member-mobile-switcher"
    />
  ) : null;

  const selectedServer = servers.find(item => item.id === currentServerId);
  const createInviteAction: PresentationAction = {
    disabled: !canManage || pendingAction !== null,
    id: "create-invite",
    kind: "primary",
    label: "创建邀请",
    run: () => setCreatingInvite(true),
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
      items: members.map(item => ({
        id: item.id,
        meta: memberIdentityLabel(item) ?? undefined,
        onSelect: () => setSelectedMemberId(item.id),
        selected: item.id === selected?.id,
        status: memberStatusLabel[item.status],
        subtitle: `${memberKindLabel[item.kind]} · ${memberRoleLabel[item.role]}`,
        title: item.displayName,
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
                id: "invite-expires-at",
                label: "有效期",
                onChange: setInviteExpiresAt,
                placeholder: "例如：2026-08-05 18:00",
                value: inviteExpiresAt,
              },
              {
                disabled: pendingAction !== null,
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
                  action: acceptInviteAction,
                  description: "通过邀请把 Human 或 Agent 加入当前 Server。",
                  title: "还没有成员",
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
    shell: {
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "members",
      navigation: ([
        ["chat", "聊天"],
        ["tasks", "任务"],
        ["agents", "Agent"],
        ["computers", "Computer"],
        ["members", "成员"],
      ] as const).map(([section, label]) => ({
        id: `navigate-${section}`,
        label,
        run: () => onNavigateSection(section),
      })),
      ...(onLogout ? {onLogout} : {}),
      serverName: selectedServer?.name,
      serverOptions: servers.map(server => ({
        id: server.id,
        label: server.name,
        onSelect: () => onSelectServer(server.id),
        selected: server.id === currentServerId,
      })),
    },
  });

  return (
    <ManagementPresentation model={semanticModel}>
    <PlatformFrame
      account={currentAccount}
      activeSection="members"
      canManageServer={canManage}
      currentServerId={currentServerId}
      imStatus={imStatus}
      navigation={stackedCollection ? null : desktopNavigation}
      onLogout={onLogout}
      onNavigateSection={onNavigateSection}
      onSelectServer={onSelectServer}
      sectionHref={sectionHref}
      serverHref={serverHref}
      servers={servers}
      viewportWidth={viewportWidth}
    >
      <ManagementStage>
        <ManagementHeader
          actions={(
            <View style={styles.headerActions}>
            <IconActionButton
              accessibilityLabel="刷新成员"
              context="header"
              disabled={loading}
              icon={RefreshCw}
              onPress={onRefresh}
              testID="member-refresh-icon"
            />
            {canManage && !creatingInvite ? (
              <ActionButton
                accessibilityLabel="创建邀请"
                context="header"
                icon={Plus}
                iconTestID="member-create-icon"
                importance="tonal"
                label="邀请"
                onPress={() => setCreatingInvite(true)}
              />
            ) : null}
            </View>
          )}
          title={creatingInvite
            ? "创建邀请"
            : acceptingInvite
              ? "接受邀请"
              : "成员"}
          titleTestID="member-stage-title"
        />
        {error ? <InlineFeedback message={error} /> : null}
        {members.length > 1 && !creatingInvite && !acceptingInvite
          ? phone
            ? mobileNavigation
            : showStackedCollection
              ? desktopNavigation
              : null
          : null}
        <ManagementDetailScroll
          density={phone ? "compact" : medium ? "medium" : "comfortable"}
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
              disabled={pendingAction !== null}
              expiresAt={inviteExpiresAt}
              maxUses={inviteMaxUses}
              onCancel={cancelInvite}
              onChangeExpiresAt={setInviteExpiresAt}
              onChangeMaxUses={setInviteMaxUses}
              onChangeRole={setInviteRole}
              onSubmit={submitInvite}
              role={inviteRole}
            />
          ) : null}
          {inviteSecret ? (
            <InviteSecretPanel
              onClose={() => setInviteSecret(null)}
              secret={inviteSecret}
            />
          ) : null}
          {!creatingInvite && !acceptingInvite ? (
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
                      <ActionButton
                        accessibilityLabel={
                          selected.role === "admin"
                            ? `将 ${selected.displayName} 设为普通成员`
                            : `将 ${selected.displayName} 设为管理员`
                        }
                        disabled={pendingAction !== null}
                        importance="secondary"
                        label={selected.role === "admin"
                          ? "设为普通成员"
                          : "设为管理员"}
                        onPress={() =>
                          onUpdateMember(selected.id, {
                            role: selected.role === "admin" ? "member" : "admin",
                          })
                        }
                      />
                      {confirmRemoveId === selected.id ? (
                        <View style={styles.confirmBox}>
                          <Text style={styles.warning}>
                            确认将 {selected.displayName} 移出 Server？
                          </Text>
                          <ActionButton
                            accessibilityLabel={`确认移除 ${selected.displayName}`}
                            importance="danger"
                            label="确认移除"
                            onPress={async () => {
                              await onRemoveMember(selected.id);
                              setConfirmRemoveId(null);
                            }}
                          />
                        </View>
                      ) : (
                        <ActionButton
                          accessibilityLabel={`移除成员 ${selected.displayName}`}
                          importance="danger"
                          label="移除成员"
                          onPress={() => setConfirmRemoveId(selected.id)}
                        />
                      )}
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
                      <ActionButton
                        accessibilityLabel={`撤销邀请 ${invite.id}`}
                        disabled={pendingAction !== null}
                        importance="danger"
                        label="撤销"
                        onPress={() => onRevokeInvite(invite.id)}
                      />
                    </View>
                  ))}
                </DetailSection>
              ) : null}
              <ResourceActionRow
                action={(
                  <ActionButton
                    accessibilityLabel="接受其他 Server 邀请"
                    importance="secondary"
                    label="使用邀请 token"
                    onPress={() => setAcceptingInvite(true)}
                  />
                )}
                description="使用其他 Server 发来的一次性邀请。"
                testID="member-join-server"
                title="加入其他 Server"
              />
            </ManagementDetailCanvas>
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
                  <ActionButton
                    accessibilityLabel="接受邀请"
                    disabled={
                      pendingAction !== null || acceptToken.trim().length === 0
                    }
                    importance="primary"
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
                <ActionButton
                  accessibilityLabel="取消接受邀请"
                  importance="secondary"
                  label="取消"
                  onPress={() => setAcceptingInvite(false)}
                />
              </DetailSection>
            </ManagementDetailCanvas>
          ) : null}
        </ManagementDetailScroll>
      </ManagementStage>
    </PlatformFrame>
    </ManagementPresentation>
  );
}

function InviteForm({
  disabled,
  expiresAt,
  maxUses,
  onCancel,
  onChangeExpiresAt,
  onChangeMaxUses,
  onChangeRole,
  onSubmit,
  role,
}: {
  disabled: boolean;
  expiresAt: string;
  maxUses: string;
  onCancel(): void;
  onChangeExpiresAt(value: string): void;
  onChangeMaxUses(value: string): void;
  onChangeRole(value: Invite["role"]): void;
  onSubmit(input: CreateInviteInput): void | Promise<void>;
  role: Invite["role"];
}) {
  const normalizedExpiresAt = normalizeLocalDateTime(
    expiresAt,
    deviceTimezone(),
  );
  const expiresAtError = expiresAt.trim()
    ? validateInviteExpiration(normalizedExpiresAt)
    : null;
  const maxUsesError = validateInviteMaxUses(maxUses);
  const formValid =
    expiresAt.trim().length > 0 &&
    !expiresAtError &&
    !maxUsesError;
  return (
    <ManagementForm testID="member-invite-form">
      <SelectionGroup>
        {(["member", "admin"] as const).map((value) => (
          <SelectionButton
            accessibilityLabel={
              value === "admin" ? "邀请管理员" : "邀请普通成员"
            }
            key={value}
            label={value === "admin" ? "管理员" : "普通成员"}
            layout="equal"
            onPress={() => onChangeRole(value)}
            selected={role === value}
          />
        ))}
      </SelectionGroup>
      <View style={styles.formGrid}>
        <ManagementField
          error={expiresAtError}
          label="有效期"
          layout="flex"
        >
          <ManagementDateTimeInput
            accessibilityLabel="邀请有效期"
            disabled={disabled}
            invalid={Boolean(expiresAtError)}
            onChangeText={onChangeExpiresAt}
            placeholder="例如：2026-08-03 18:00"
            value={expiresAt}
          />
        </ManagementField>
        <ManagementField
          error={maxUsesError}
          label="最大使用次数"
          layout="compact"
        >
          <ManagementTextInput
            accessibilityLabel="邀请最大使用次数"
            invalid={Boolean(maxUsesError)}
            keyboardType="number-pad"
            onChangeText={onChangeMaxUses}
            value={maxUses}
          />
        </ManagementField>
      </View>
      <ManagementFormActions>
        <ActionButton
          accessibilityLabel="取消创建邀请"
          importance="secondary"
          label="取消"
          onPress={onCancel}
        />
        <ActionButton
          accessibilityLabel="生成邀请链接"
          disabled={disabled || !formValid}
          importance="primary"
          label="生成邀请链接"
          onPress={() =>
            onSubmit({
              expiresAt: normalizedExpiresAt,
              maxUses: Number.parseInt(maxUses, 10),
              role,
            })
          }
        />
      </ManagementFormActions>
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

const memberKindLabel: Record<Member["kind"], string> = {
  agent: "Agent",
  human: "自然人",
};

const memberRoleLabel: Record<Member["role"], string> = {
  admin: "管理员",
  member: "成员",
  owner: "所有者",
};

const memberImStateLabel: Record<Member["imState"], string> = {
  error: "连接异常",
  provisioning: "连接中",
  ready: "已连接",
};

const memberStatusLabel: Record<Member["status"], string> = {
  active: "正常",
  removing: "移除中",
  removed: "已移除",
};

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
        <IconActionButton
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
  avatar: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.avatarHumanVioletSurface,
    borderColor: theme.semantic.color.avatarHumanVioletBorder,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    height: theme.recipes.managementWorkspace.collectionAvatarSize,
    justifyContent: "center",
    width: theme.recipes.managementWorkspace.collectionAvatarSize,
  },
  avatarAgent: {
    backgroundColor: theme.semantic.color.avatarAgentSurface,
  },
  avatarText: {
    color: theme.semantic.color.avatarHumanVioletText,
    ...theme.semantic.typography.body,
  },
  confirmBox: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.statusDangerSurface,
    borderColor: theme.semantic.color.borderDanger,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
  },
  formGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  headerActions: {
    flexDirection: "row",
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
  list: {
    gap: theme.spacing.xs,
    padding: theme.spacing.sm,
  },
  listStacked: {
    alignItems: "center",
  },
  listScroller: {
    flex: 1,
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
