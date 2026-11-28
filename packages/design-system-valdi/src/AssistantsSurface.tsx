import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler } from "./haptics";
import { SettingsGroup, SettingsListItem, SettingsPageHeader } from "./SettingsGroup";
import { themeColors, themeMetrics } from "./tokens";

export type AssistantActorCardItem = {
  readonly id: string;
  readonly title: string;
  readonly badgeText?: string;
  readonly scopeText?: string;
  readonly statusText: string;
  readonly dutiesText?: string;
  readonly paused: boolean;
  readonly configRequired?: boolean;
  readonly primaryActionKind: "chat" | "choose-model" | "resume";
  readonly primaryActionLabel: string;
  readonly memoryLabel: string;
  readonly settingsLabel: string;
  readonly pauseLabel?: string;
  readonly busy?: boolean;
  readonly activeOperation?: "open" | "pause" | "hire" | null;
};

export type AssistantPresetCardItem = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly cardinalityLabel?: string;
  readonly hireLabel: string;
  readonly hiring?: boolean;
  readonly disabled?: boolean;
};

/** Kept as an alias so external type consumers remain source-compatible. */
export type ManagedBotItem = AssistantActorCardItem;

export type AssistantsSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title?: string;
  readonly subtitle?: string;
  readonly hostNoticeText?: string;
  readonly loading?: boolean;
  readonly errorText?: string;
  readonly retryLabel: string;
  readonly myAgentsTitle: string;
  readonly myAgentsDescription?: string;
  readonly createLabel: string;
  readonly createDisabled?: boolean;
  readonly emptyMineText: string;
  readonly actors: readonly AssistantActorCardItem[];
  readonly availableTitle: string;
  readonly presets: readonly AssistantPresetCardItem[];
  readonly onCreateActor: () => void;
  readonly onRetry: () => void;
  readonly onHirePreset: (presetId: string) => void;
  readonly onPrimaryAction: (botId: string) => void;
  readonly onOpenMemory: (botId: string) => void;
  readonly onOpenSettings: (botId: string) => void;
  readonly onTogglePause: (botId: string) => void;
  readonly onHaptic?: (style: string) => void;
};

/**
 * Unified OpenCraft Valdi surface for Assistants (`/views/opencraft.im.agents`).
 * Presents all `AssistantActor` (`session://`) instances under one lifecycle,
 * collaboration scope, memory, settings, environment, and DM contract.
 */
export class AssistantsSurface extends StatefulComponent<AssistantsSurfaceProps, Record<string, never>> {
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
    const showHeader = Boolean(vm.title || vm.subtitle);
    const showSkeleton = Boolean(vm.loading && vm.actors.length === 0 && !vm.errorText);

    <view width="100%" gap={24}>
      {showHeader ? (
        <SettingsPageHeader title={vm.title ?? ""} description={vm.subtitle} touch={vm.touch} dark={dark} />
      ) : null}

      {vm.hostNoticeText ? (
        <Banner id="oc-assistants-host-notice" tone="info" title={vm.hostNoticeText} touch={vm.touch} dark={dark} />
      ) : null}

      {vm.errorText ? (
        <Banner id="oc-assistants-error" tone="danger" title={vm.errorText} touch={vm.touch} dark={dark}>
          <Button
            id="oc-assistants-retry"
            title={vm.retryLabel}
            variant="secondary"
            size="sm"
            touch={vm.touch}
            dark={dark}
            onPress={vm.onRetry}
          />
        </Banner>
      ) : null}

      <SettingsGroup title={vm.myAgentsTitle} description={vm.myAgentsDescription} touch={vm.touch} dark={dark}>
        <view width="100%" padding={16} flexDirection="row" alignItems="center" justifyContent="space-between" gap={12}>
          <view flexGrow={1} flexShrink={1} minWidth={0}>
            {vm.actors.length === 0 && !showSkeleton && !vm.errorText ? (
              <label value={vm.emptyMineText} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
            ) : null}
          </view>
          <Button
            id="oc-assistant-create"
            title={vm.createLabel}
            variant="primary"
            size="sm"
            disabled={vm.createDisabled}
            touch={vm.touch}
            dark={dark}
            onPress={vm.onCreateActor}
          />
        </view>

        {showSkeleton ? (
          <view
            class="oc-cold-skeleton"
            width="100%"
            minHeight={64}
            padding={16}
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            gap={12}
          >
            <view gap={6} flexGrow={1}>
              <view width={112} height={13} borderRadius={6} backgroundColor={c.recessed} />
              <view width={220} height={11} borderRadius={5} backgroundColor={c.recessed} />
            </view>
            <view width={72} height={28} borderRadius={8} backgroundColor={c.recessed} />
          </view>
        ) : null}

        {vm.actors.length > 0
          ? vm.actors.forEach((actor) => {
              const titleParts = [actor.title];
              if (actor.badgeText) titleParts.push(actor.badgeText);
              const titleText = titleParts.join(" · ");
              const statusWithScope = actor.scopeText ? `${actor.scopeText} · ${actor.statusText}` : actor.statusText;
              const detailText = actor.dutiesText ? `${statusWithScope}\n${actor.dutiesText}` : statusWithScope;
              const primaryVariant =
                actor.primaryActionKind === "resume" || actor.primaryActionKind === "choose-model"
                  ? "primary"
                  : "secondary";

              <view key={actor.id} class="managed-bots__row" width="100%">
                <SettingsListItem
                  id={`oc-assistant-actor-${actor.id}`}
                  icon="bot"
                  title={titleText}
                  description={detailText}
                  divider
                  touch={vm.touch}
                  dark={dark}
                >
                  <view flexDirection="row" alignItems="center" flexWrap="wrap" justifyContent="flex-end" gap={6}>
                    <Button
                      id={`oc-assistant-primary-${actor.id}`}
                      title={actor.primaryActionLabel}
                      variant={primaryVariant}
                      size="sm"
                      loading={
                        (actor.primaryActionKind === "chat" && actor.activeOperation === "open") ||
                        (actor.primaryActionKind === "resume" && actor.activeOperation === "pause")
                      }
                      disabled={actor.busy}
                      touch={vm.touch}
                      dark={dark}
                      onPress={() => vm.onPrimaryAction(actor.id)}
                    />
                    <Button
                      id={`oc-assistant-memory-${actor.id}`}
                      title={actor.memoryLabel}
                      variant="secondary"
                      size="sm"
                      disabled={actor.busy}
                      touch={vm.touch}
                      dark={dark}
                      onPress={() => vm.onOpenMemory(actor.id)}
                    />
                    <Button
                      id={`oc-assistant-settings-${actor.id}`}
                      title={actor.settingsLabel}
                      variant="secondary"
                      size="sm"
                      disabled={actor.busy}
                      touch={vm.touch}
                      dark={dark}
                      onPress={() => vm.onOpenSettings(actor.id)}
                    />
                    {!actor.paused && actor.pauseLabel ? (
                      <Button
                        id={`oc-assistant-pause-${actor.id}`}
                        title={actor.pauseLabel}
                        variant="secondary"
                        size="sm"
                        loading={actor.activeOperation === "pause"}
                        disabled={actor.busy}
                        touch={vm.touch}
                        dark={dark}
                        onPress={() => vm.onTogglePause(actor.id)}
                      />
                    ) : null}
                  </view>
                </SettingsListItem>
              </view>;
            })
          : null}
      </SettingsGroup>

      {!showSkeleton && vm.presets.length > 0 ? (
        <SettingsGroup title={vm.availableTitle} touch={vm.touch} dark={dark}>
          {vm.presets.forEach((preset, idx) => {
            const presetDescription = preset.cardinalityLabel
              ? `${preset.description}\n${preset.cardinalityLabel}`
              : preset.description;
            <SettingsListItem
              key={preset.id}
              id={`oc-assistant-preset-${preset.id}`}
              icon="bot"
              title={preset.title}
              description={presetDescription}
              divider={idx > 0}
              touch={vm.touch}
              dark={dark}
            >
              <Button
                id={`oc-assistant-hire-${preset.id}`}
                title={preset.hireLabel}
                variant="primary"
                size="sm"
                loading={preset.hiring}
                disabled={preset.disabled}
                touch={vm.touch}
                dark={dark}
                onPress={() => vm.onHirePreset(preset.id)}
              />
            </SettingsListItem>;
          })}
        </SettingsGroup>
      ) : null}
    </view>;
  }
}
