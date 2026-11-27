import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { registerHapticHandler } from "./haptics";
import { SettingsGroup, SettingsListItem, SettingsPageHeader } from "./SettingsGroup";
import { themeColors, themeMetrics } from "./tokens";

export type ArchivedThreadItem = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly restoring?: boolean;
};

export type ArchivedThreadsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly loading?: boolean;
  readonly loadingText: string;
  readonly errorMessage?: string;
  readonly emptyText: string;
  readonly refreshLabel: string;
  readonly restoreLabel: string;
  readonly restoringLabel: string;
  readonly items: readonly ArchivedThreadItem[];
  readonly busy?: boolean;
  readonly onRefresh: () => void;
  readonly onRestore: (threadId: string) => void;
  readonly onHaptic?: (style: string) => void;
};

/**
 * Adaptive OpenCraft Valdi surface for Settings -> Archived Conversations (`/settings/archived-conversations`).
 */
export class ArchivedThreadsSurface extends StatefulComponent<ArchivedThreadsProps, Record<string, never>> {
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
    const isEmpty = !vm.loading && !vm.errorMessage && vm.items.length === 0;

    <view width="100%" gap={28}>
      <SettingsPageHeader title={vm.title} touch={vm.touch} dark={dark}>
        <Button
          id="oc-archived-refresh"
          title={vm.refreshLabel}
          variant="secondary"
          size="sm"
          disabled={vm.loading}
          touch={vm.touch}
          dark={dark}
          onPress={vm.onRefresh}
        />
      </SettingsPageHeader>

      {vm.loading && (
        <view width="100%" paddingTop={4}>
          <label value={vm.loadingText} font={m.fonts.body} color={c.muted} numberOfLines={1} />
        </view>
      )}

      {vm.errorMessage && (
        <Banner id="oc-archived-error" tone="danger" title={vm.errorMessage} touch={vm.touch} dark={dark} />
      )}

      {isEmpty && (
        <SettingsGroup title="" touch={vm.touch} dark={dark}>
          <EmptyState icon="inbox" title={vm.emptyText} description="" dark={dark} />
        </SettingsGroup>
      )}

      {vm.items.length > 0 && (
        <SettingsGroup title="" touch={vm.touch} dark={dark}>
          {vm.items.forEach((item, idx) => {
            <SettingsListItem
              key={item.id}
              id={`oc-archived-item-${item.id}`}
              title={item.title}
              description={item.description}
              divider={idx > 0}
              touch={vm.touch}
              dark={dark}
            >
              <Button
                id={`oc-archived-restore-${item.id}`}
                title={item.restoring ? vm.restoringLabel : vm.restoreLabel}
                variant="secondary"
                size="sm"
                loading={item.restoring}
                disabled={vm.busy}
                touch={vm.touch}
                dark={dark}
                onPress={() => vm.onRestore(item.id)}
              />
            </SettingsListItem>;
          })}
        </SettingsGroup>
      )}
    </view>;
  }
}
