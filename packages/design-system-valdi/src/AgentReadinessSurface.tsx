import { Component } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";
import { TextField } from "./TextField";
import { themeColors, themeMetrics } from "./tokens";

export type AgentReadinessProps = {
  id?: string;
  agentName: string;
  statusTitle: string;
  description: string;
  icon?: IconName;
  version?: string | null;
  account?: string | null;
  phase?: "idle" | "running" | "failed";
  errorMessage?: string | null;
  primaryActionTitle?: string | null;
  secondaryActionTitle?: string | null;
  openLinkTitle?: string | null;
  userCode?: string | null;
  copyCodeTitle?: string | null;
  awaitingCode?: boolean;
  authCodeValue?: string;
  authCodePlaceholder?: string;
  submitCodeTitle?: string | null;
  touch?: boolean;
  dark?: boolean;
  onPrimaryAction?(): void;
  onSecondaryAction?(): void;
  onOpenLink?(): void;
  onCopyCode?(): void;
  onAuthCodeChange?(value: string): void;
  onSubmitCode?(): void;
};

/** Compact inline readiness & setup surface for unconfigured Harnesses inside menus and panels. */
export class AgentReadinessSurface extends Component<AgentReadinessProps> {
  onRender(): void {
    const vm = this.viewModel;
    const c = themeColors(vm.dark);
    const m = themeMetrics(vm.touch);
    const baseId = vm.id ?? "agent-readiness";
    const isRunning = vm.phase === "running";
    const isFailed = vm.phase === "failed";
    const metaParts = [vm.version, vm.account].filter((item): item is string => Boolean(item && item.trim()));

    <view accessibilityId={baseId} width="100%" padding={16} gap={12}>
      <view width="100%" flexDirection="row" alignItems="flex-start" gap={12}>
        <view
          width={36}
          height={36}
          flexShrink={0}
          borderRadius={m.radii.iconBox}
          backgroundColor={c.recessed}
          borderWidth={0.5}
          borderColor={c.border}
          alignItems="center"
          justifyContent="center"
          accessibilityNavigation="ignored"
        >
          <Icon name={isRunning ? "refresh" : (vm.icon ?? "terminal")} size={18} color={isFailed ? c.danger : c.ink} />
        </view>
        <view flexGrow={1} flexShrink={1} minWidth={0} gap={4}>
          <view width="100%" flexDirection="row" alignItems="center" justifyContent="space-between" gap={8}>
            <view flexShrink={1} minWidth={0}>
              <label value={vm.agentName} font={m.fonts.rowTitle} color={c.ink} numberOfLines={1} />
            </view>
            <view
              flexShrink={0}
              paddingLeft={7}
              paddingRight={7}
              paddingTop={2}
              paddingBottom={2}
              borderRadius={6}
              backgroundColor={isFailed ? c.dangerSurface : c.trackSoft}
            >
              <label
                value={vm.statusTitle}
                font={m.fonts.caption}
                color={isFailed ? c.danger : c.muted}
                numberOfLines={1}
              />
            </view>
          </view>
          <view width="100%" minWidth={0}>
            <label value={vm.description} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
          </view>
          {metaParts.length > 0 ? (
            <view class="oc-mono" width="100%" minWidth={0} paddingTop={2}>
              <label value={metaParts.join(" · ")} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
            </view>
          ) : null}
        </view>
      </view>

      {isFailed && vm.errorMessage ? (
        <Banner tone="danger" title={vm.statusTitle} message={vm.errorMessage} touch={vm.touch} dark={vm.dark} />
      ) : null}

      {vm.userCode ? (
        <view
          width="100%"
          paddingLeft={12}
          paddingRight={10}
          paddingTop={8}
          paddingBottom={8}
          borderRadius={m.radii.control}
          backgroundColor={c.recessed}
          borderWidth={0.5}
          borderColor={c.border}
          flexDirection="row"
          alignItems="center"
          justifyContent="space-between"
          gap={8}
        >
          <view class="oc-mono" flexGrow={1} minWidth={0}>
            <label value={vm.userCode} font={m.fonts.control} color={c.ink} numberOfLines={1} />
          </view>
          {vm.copyCodeTitle && vm.onCopyCode ? (
            <Button
              id={`${baseId}-copy-code`}
              title={vm.copyCodeTitle}
              variant="ghost"
              size="sm"
              leadingIcon="copy"
              touch={vm.touch}
              dark={vm.dark}
              onPress={vm.onCopyCode}
            />
          ) : null}
        </view>
      ) : null}

      {vm.awaitingCode && vm.onAuthCodeChange && vm.onSubmitCode ? (
        <view class="oc-mono" width="100%" gap={8}>
          <TextField
            id={`${baseId}-auth-code`}
            label={vm.authCodePlaceholder ?? vm.agentName}
            value={vm.authCodeValue ?? ""}
            placeholder={vm.authCodePlaceholder ?? ""}
            touch={vm.touch}
            dark={vm.dark}
            onChange={vm.onAuthCodeChange}
          />
          {vm.submitCodeTitle ? (
            <Button
              id={`${baseId}-submit-code`}
              title={vm.submitCodeTitle}
              variant="primary"
              size="sm"
              disabled={!(vm.authCodeValue ?? "").trim()}
              touch={vm.touch}
              dark={vm.dark}
              onPress={vm.onSubmitCode}
            />
          ) : null}
        </view>
      ) : null}

      {vm.primaryActionTitle || vm.openLinkTitle || vm.secondaryActionTitle ? (
        <view width="100%" flexDirection="row" flexWrap="wrap" alignItems="center" gap={8}>
          {vm.primaryActionTitle && vm.onPrimaryAction ? (
            <Button
              id={`${baseId}-primary`}
              title={vm.primaryActionTitle}
              variant="primary"
              size="sm"
              loading={isRunning && !vm.openLinkTitle}
              disabled={isRunning && !vm.openLinkTitle}
              touch={vm.touch}
              dark={vm.dark}
              onPress={vm.onPrimaryAction}
            />
          ) : null}
          {vm.openLinkTitle && vm.onOpenLink ? (
            <Button
              id={`${baseId}-open-link`}
              title={vm.openLinkTitle}
              variant="secondary"
              size="sm"
              leadingIcon="external"
              touch={vm.touch}
              dark={vm.dark}
              onPress={vm.onOpenLink}
            />
          ) : null}
          {vm.secondaryActionTitle && vm.onSecondaryAction ? (
            <Button
              id={`${baseId}-secondary`}
              title={vm.secondaryActionTitle}
              variant="ghost"
              size="sm"
              touch={vm.touch}
              dark={vm.dark}
              onPress={vm.onSecondaryAction}
            />
          ) : null}
        </view>
      ) : null}
    </view>;
  }
}
