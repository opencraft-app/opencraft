import { Component, StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { registerHapticHandler } from "./haptics";
import { SegmentedControl } from "./SegmentedControl";
import { SettingsGroup, SettingsListItem, SettingsPageHeader } from "./SettingsGroup";
import { TextField } from "./TextField";
import { themeColors, themeMetrics } from "./tokens";

export type InboxTabId = "groups" | "work" | "members";

export type InboxGroupItem = {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
  readonly metaText?: string;
  readonly unreadText?: string;
  readonly selected?: boolean;
  readonly isAssistant?: boolean;
  readonly disabled?: boolean;
};

export type InboxMemberItem = {
  readonly id: string;
  readonly displayName: string;
  readonly kindLabel: string;
  readonly isBot?: boolean;
  readonly reachable?: boolean;
  readonly busy?: boolean;
};

export type InboxSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly activeTab: InboxTabId;
  readonly searchQuery: string;
  readonly searchPlaceholder: string;
  readonly clearSearchLabel?: string;
  readonly createGroupLabel?: string;
  readonly showCreateGroup?: boolean;
  readonly groupsLabel: string;
  readonly workLabel: string;
  readonly membersLabel: string;
  readonly loadingText: string;
  readonly retryLabel: string;
  readonly groupsLoading?: boolean;
  readonly groupsError?: string;
  readonly emptyGroupsText: string;
  readonly groups: readonly InboxGroupItem[];
  readonly membersLoading?: boolean;
  readonly membersError?: string;
  readonly emptyMembersText: string;
  readonly members: readonly InboxMemberItem[];
  readonly loadMoreLabel?: string;
  readonly hasMoreMembers?: boolean;
  readonly onSearchChange: (query: string) => void;
  readonly onCreateGroup?: () => void;
  readonly onTabChange: (tab: InboxTabId) => void;
  readonly onOpenGroup: (id: string, isAssistant?: boolean) => void;
  readonly onRetryGroups: () => void;
  readonly onOpenMember: (id: string) => void;
  readonly onRetryMembers: () => void;
  readonly onLoadMoreMembers?: () => void;
  readonly onHaptic?: (style: string) => void;
};

/**
 * Adaptive OpenCraft Valdi surface for the Inbox directory (`/views/opencraft.im.people`).
 */
export class InboxSurface extends StatefulComponent<InboxSurfaceProps, Record<string, never>> {
  state: Record<string, never> = {};

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onViewModelUpdate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const m = themeMetrics(vm.touch);

    <view width="100%" gap={20}>
      <SettingsPageHeader title={vm.title} touch={vm.touch} dark={dark} />

      <view width="100%" gap={12}>
        <view width="100%" flexDirection="row" alignItems="center" gap={8}>
          <view flexGrow={1} flexShrink={1} minWidth={0}>
            <TextField
              id="oc-inbox-search"
              label={vm.searchPlaceholder}
              hideLabel
              value={vm.searchQuery}
              placeholder={vm.searchPlaceholder}
              clearTitle={vm.clearSearchLabel ?? vm.retryLabel}
              leadingIcon="search"
              touch={vm.touch}
              dark={dark}
              onChange={vm.onSearchChange}
            />
          </view>
          {vm.showCreateGroup && vm.onCreateGroup ? (
            <Button
              id="oc-inbox-create-group"
              title={vm.createGroupLabel ?? "+"}
              variant="secondary"
              size="sm"
              touch={vm.touch}
              dark={dark}
              onPress={vm.onCreateGroup}
            />
          ) : null}
        </view>

        <SegmentedControl
          id="oc-inbox-tabs"
          label={vm.title}
          value={vm.activeTab}
          options={[
            { id: "groups", title: vm.groupsLabel },
            { id: "work", title: vm.workLabel },
            { id: "members", title: vm.membersLabel },
          ]}
          compact
          touch={vm.touch}
          dark={dark}
          onChange={(value) => vm.onTabChange(value as InboxTabId)}
        />
      </view>

      {vm.activeTab === "groups" ? (
        <view width="100%" gap={12}>
          {vm.groupsError ? (
            <Banner id="oc-inbox-groups-error" tone="danger" title={vm.groupsError} touch={vm.touch} dark={dark}>
              <Button
                id="oc-inbox-groups-retry"
                title={vm.retryLabel}
                variant="secondary"
                size="sm"
                touch={vm.touch}
                dark={dark}
                onPress={vm.onRetryGroups}
              />
            </Banner>
          ) : null}

          {vm.groupsLoading && vm.groups.length === 0 ? (
            <view
              class="oc-cold-skeleton"
              width="100%"
              minHeight={120}
              borderRadius={m.radii.card}
              backgroundColor={c.surface}
              borderWidth={0.5}
              borderColor={c.border}
              padding={16}
              gap={12}
            >
              <view width="60%" height={13} borderRadius={6} backgroundColor={c.recessed} />
              <view width="80%" height={11} borderRadius={5} backgroundColor={c.recessed} />
            </view>
          ) : vm.groups.length > 0 ? (
            <SettingsGroup title="" touch={vm.touch} dark={dark}>
              {vm.groups.forEach((group, idx) => {
                <SettingsListItem
                  key={group.id}
                  id={`oc-inbox-group-${group.id}`}
                  icon={group.isAssistant ? "bot" : "chat"}
                  title={group.title}
                  description={group.preview}
                  metadata={
                    group.unreadText
                      ? `${group.unreadText}${group.metaText ? ` · ${group.metaText}` : ""}`
                      : group.metaText
                  }
                  divider={idx > 0}
                  touch={vm.touch}
                  dark={dark}
                  onOpen={group.disabled ? undefined : () => vm.onOpenGroup(group.id, group.isAssistant)}
                />;
              })}
            </SettingsGroup>
          ) : !vm.groupsError ? (
            <EmptyState icon="inbox" title={vm.emptyGroupsText} description="" dark={dark} />
          ) : null}
        </view>
      ) : null}

      {vm.activeTab === "members" ? (
        <view width="100%" gap={12}>
          {vm.membersError ? (
            <Banner id="oc-inbox-members-error" tone="danger" title={vm.membersError} touch={vm.touch} dark={dark}>
              <Button
                id="oc-inbox-members-retry"
                title={vm.retryLabel}
                variant="secondary"
                size="sm"
                touch={vm.touch}
                dark={dark}
                onPress={vm.onRetryMembers}
              />
            </Banner>
          ) : null}

          {vm.membersLoading && vm.members.length === 0 ? (
            <view
              class="oc-cold-skeleton"
              width="100%"
              minHeight={120}
              borderRadius={m.radii.card}
              backgroundColor={c.surface}
              borderWidth={0.5}
              borderColor={c.border}
              padding={16}
              gap={12}
            >
              <view width="55%" height={13} borderRadius={6} backgroundColor={c.recessed} />
              <view width="40%" height={11} borderRadius={5} backgroundColor={c.recessed} />
            </view>
          ) : vm.members.length > 0 ? (
            <SettingsGroup title="" touch={vm.touch} dark={dark}>
              {vm.members.forEach((member, idx) => {
                <SettingsListItem
                  key={member.id}
                  id={`oc-inbox-member-${member.id}`}
                  icon={member.isBot ? "bot" : "user"}
                  title={member.displayName}
                  metadata={member.kindLabel}
                  divider={idx > 0}
                  touch={vm.touch}
                  dark={dark}
                  onOpen={member.reachable && !member.busy ? () => vm.onOpenMember(member.id) : undefined}
                />;
              })}
            </SettingsGroup>
          ) : !vm.membersError ? (
            <EmptyState icon="user" title={vm.emptyMembersText} description="" dark={dark} />
          ) : null}

          {vm.hasMoreMembers && vm.loadMoreLabel && vm.onLoadMoreMembers ? (
            <view width="100%" alignItems="center">
              <Button
                id="oc-inbox-load-more"
                title={vm.loadMoreLabel}
                variant="secondary"
                size="sm"
                disabled={vm.membersLoading}
                touch={vm.touch}
                dark={dark}
                onPress={vm.onLoadMoreMembers}
              />
            </view>
          ) : null}
        </view>
      ) : null}
    </view>;
  }
}

export type InboxEmptyProps = {
  readonly dark?: boolean;
  readonly title: string;
};

/**
 * Adaptive OpenCraft Valdi empty state for the Inbox detail pane.
 */
export class InboxEmptySurface extends Component<InboxEmptyProps> {
  onRender(): void {
    const { dark, title } = this.viewModel;
    <view width="100%" height="100%" alignItems="center" justifyContent="center" padding={24}>
      <EmptyState icon="chat" title={title} description="" dark={dark} />
    </view>;
  }
}
