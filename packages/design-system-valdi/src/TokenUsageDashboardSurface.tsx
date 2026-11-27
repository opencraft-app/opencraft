import { StatefulComponent } from "valdi_core/src/Component";
import { systemSemiboldFont } from "valdi_core/src/SystemFont";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { Icon } from "./Icon";
import { ProgressBar } from "./ProgressBar";
import { SegmentedControl } from "./SegmentedControl";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { SettingsFormRow, SettingsGroup, SettingsListItem, SettingsPageHeader } from "./SettingsGroup";
import type { TokenUsageMetricItem, TokenUsageWindowItem } from "./SidebarDockSurface";
import { TextField } from "./TextField";
import { radii, themeColors, themeMetrics } from "./tokens";

export type TokenUsageLocalSection = {
  readonly machineLabel?: string;
  readonly machines?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly selectedMachineId?: string;
  readonly providerLabel: string;
  readonly providers: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly selectedProviderId: string;
  readonly planText?: string;
  readonly accountText?: string;
  readonly quotaGroupTitle: string;
  readonly quotaGroupDescription: string;
  readonly statusMessage?: string;
  readonly windows: readonly TokenUsageWindowItem[];
  readonly conversationGroupTitle: string;
  readonly conversationProvider?: string;
  readonly contextLabel?: string;
  readonly contextDetail?: string;
  readonly contextProgress?: number;
  readonly conversationFallback?: string;
  readonly metrics: readonly TokenUsageMetricItem[];
  readonly observedAtText?: string;
  readonly serverLedgerNote?: string;
  readonly onSelectMachine?: (id: string) => void;
  readonly onSelectProvider: (id: string) => void;
};

export type TokenUsageLedgerMetricItem = {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly detail: string;
};

export type TokenUsageHeatmapCell = {
  readonly date: string;
  readonly level: number;
  readonly outside: boolean;
  readonly summaryText: string;
};

export type TokenUsageHeatmapWeek = {
  readonly key: string;
  readonly monthLabel?: string;
  readonly cells: readonly TokenUsageHeatmapCell[];
};

export type TokenUsageBarItem = {
  readonly key: string;
  readonly label: string;
  readonly progress: number;
  readonly valueText: string;
};

export type TokenUsageModelCardItem = {
  readonly key: string;
  readonly label: string;
  readonly tokensText: string;
  readonly turnsText: string;
  readonly progress: number;
};

export type TokenUsageTableRowItem = {
  readonly key: string;
  readonly title: string;
  readonly tokensText: string;
  readonly turnsText: string;
  readonly interactive?: boolean;
};

export type TokenUsageTurnRowItem = {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
};

export type TokenUsageDiagnosticStatItem = {
  readonly label: string;
  readonly value: string;
};

export type TokenUsageLedgerSection = {
  readonly scopeLabel: string;
  readonly scopeValue: string;
  readonly scopeOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly rangeLabel: string;
  readonly rangeValue: string;
  readonly rangeOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly customRange?: {
    readonly fromLabel: string;
    readonly fromValue: string;
    readonly throughLabel: string;
    readonly throughValue: string;
    readonly onChangeFrom: (value: string) => void;
    readonly onChangeThrough: (value: string) => void;
  };
  readonly modelLabel: string;
  readonly modelValue: string;
  readonly modelOptions: readonly SelectMenuOption[];
  readonly summaryTitle?: string;
  readonly summarySubtitle?: string;
  readonly partialBadge?: string;
  readonly summaryMeta?: string;
  readonly metrics?: readonly TokenUsageLedgerMetricItem[];
  readonly activityTitle?: string;
  readonly activitySubtitle?: string;
  readonly activityMode: string;
  readonly activityModeOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly weekdayLabels?: readonly string[];
  readonly heatmapWeeks?: readonly TokenUsageHeatmapWeek[];
  readonly defaultCellHint?: string;
  readonly bars?: readonly TokenUsageBarItem[];
  readonly modelSectionTitle?: string;
  readonly modelEmptyText?: string;
  readonly modelCards?: readonly TokenUsageModelCardItem[];
  readonly detailTitle?: string;
  readonly detailEmptyText?: string;
  readonly backToSummaryLabel?: string;
  readonly viewLabel?: string;
  readonly viewValue?: string;
  readonly viewOptions?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly clearActorLabel?: string;
  readonly rows?: readonly TokenUsageTableRowItem[];
  readonly turnRows?: readonly TokenUsageTurnRowItem[];
  readonly nextPageLabel?: string;
  readonly firstPageLabel?: string;
  readonly diagnosticsTitle?: string;
  readonly diagnosticsToggleLabel?: string;
  readonly collectionStatusText?: string;
  readonly collectionActionLabel?: string;
  readonly diagnosticsLines?: readonly string[];
  readonly diagnosticsPartialNotice?: string;
  readonly categoryStats?: readonly TokenUsageDiagnosticStatItem[];
  readonly onChangeScope: (value: string) => void;
  readonly onChangeRange: (value: string) => void;
  readonly onChangeModel: (value: string) => void;
  readonly onChangeActivityMode: (mode: string) => void;
  readonly onChangeView?: (view: string) => void;
  readonly onSelectRow?: (key: string) => void;
  readonly onBackToSummary?: () => void;
  readonly onClearActor?: () => void;
  readonly onNextPage?: () => void;
  readonly onFirstPage?: () => void;
  readonly onToggleCollection?: () => void;
};

export type TokenUsageDashboardProps = {
  dark?: boolean;
  touch?: boolean;
  narrow?: boolean;
  title: string;
  subtitle: string;
  refreshLabel: string;
  loading?: boolean;
  loadingText?: string;
  errorMessage?: string;
  localUsage?: TokenUsageLocalSection;
  ledger?: TokenUsageLedgerSection;
  onRefresh: () => void;
  onHaptic?: (style: string) => void;
};

type State = {
  modelMenuOpen: boolean;
  selectedCellSummary: string | null;
  diagnosticsOpen: boolean;
};

/**
 * Unified OpenCraft Valdi surface for Settings -> Token Usage (`/settings/opencraft.token-usage.page`).
 * Eliminates raw `<select>` menus and supports both Local Agent Quota Windows and Server Multi-Actor Ledgers.
 */
export class TokenUsageDashboardSurface extends StatefulComponent<TokenUsageDashboardProps, State> {
  state: State = {
    modelMenuOpen: false,
    selectedCellSummary: null,
    diagnosticsOpen: false,
  };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onViewModelUpdate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  private renderInlineTrack(progress: number, fillColor: string, trackColor: string): void {
    const pct = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    <view
      width="100%"
      height={6}
      borderRadius={radii.pill}
      backgroundColor={trackColor}
      slowClipping={true}
      accessibilityNavigation="ignored"
    >
      <view width={pct} height="100%" borderRadius={radii.pill} backgroundColor={fillColor} />
    </view>;
  }

  private heatColor(level: number, dark: boolean): string {
    const c = themeColors(dark);
    if (level >= 4) return c.success;
    if (level === 3) return dark ? "rgba(139, 220, 181, 0.72)" : "rgba(35, 118, 79, 0.72)";
    if (level === 2) return dark ? "rgba(139, 220, 181, 0.46)" : "rgba(35, 118, 79, 0.46)";
    if (level === 1) return dark ? "rgba(139, 220, 181, 0.24)" : "rgba(35, 118, 79, 0.24)";
    return c.trackSubtle;
  }

  private renderLocalUsage(local: TokenUsageLocalSection, dark: boolean, touch?: boolean): void {
    const c = themeColors(dark);
    const m = themeMetrics(touch);

    <view width="100%" gap={32}>
      {/* Provider & Machine Selector Card */}
      <SettingsGroup title="" touch={touch} dark={dark}>
        {local.machines && local.machines.length > 1 && local.selectedMachineId && local.onSelectMachine && (
          <SettingsFormRow title={local.machineLabel ?? ""} touch={touch} dark={dark}>
            <SegmentedControl
              id="oc-usage-page-machines"
              label={local.machineLabel ?? ""}
              value={local.selectedMachineId}
              options={local.machines}
              compact={true}
              touch={touch}
              dark={dark}
              onChange={(id) => local.onSelectMachine?.(id)}
            />
          </SettingsFormRow>
        )}

        <SettingsFormRow
          title={local.providerLabel}
          description={[local.planText, local.accountText].filter(Boolean).join(" · ") || undefined}
          divider={Boolean(local.machines && local.machines.length > 1)}
          touch={touch}
          dark={dark}
        >
          <SegmentedControl
            id="oc-usage-page-providers"
            label={local.providerLabel}
            value={local.selectedProviderId}
            options={local.providers}
            compact={true}
            touch={touch}
            dark={dark}
            onChange={(id) => local.onSelectProvider(id)}
          />
        </SettingsFormRow>
      </SettingsGroup>

      {/* Quota Windows Card */}
      <SettingsGroup title={local.quotaGroupTitle} description={local.quotaGroupDescription} touch={touch} dark={dark}>
        {local.windows.length > 0 ? (
          <view width="100%">
            {local.windows.forEach((win, idx) => {
              <view key={win.id} width="100%">
                {idx > 0 && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
                <view width="100%" paddingLeft={16} paddingRight={16} paddingTop={14} paddingBottom={14} gap={6}>
                  <ProgressBar
                    id={`oc-usage-page-win-${win.id}`}
                    label={win.label}
                    progress={win.progress}
                    detail={[win.percentText, win.resetText].filter(Boolean).join(" · ")}
                    tone={win.warning ? "warning" : "accent"}
                    touch={touch}
                    dark={dark}
                  />
                  {win.costText && (
                    <label value={win.costText} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
                  )}
                </view>
              </view>;
            })}
          </view>
        ) : (
          <view width="100%" padding={16}>
            <label value={local.statusMessage ?? "—"} font={m.fonts.body} color={c.muted} numberOfLines={0} />
          </view>
        )}
      </SettingsGroup>

      {/* Current Conversation Context & Token Metrics */}
      <SettingsGroup title={local.conversationGroupTitle} touch={touch} dark={dark}>
        <view width="100%" padding={16} gap={14}>
          {local.contextLabel && local.contextProgress !== undefined ? (
            <ProgressBar
              id="oc-usage-page-context"
              label={local.contextLabel}
              progress={local.contextProgress}
              detail={local.contextDetail}
              tone="accent"
              touch={touch}
              dark={dark}
            />
          ) : local.conversationFallback ? (
            <label value={local.conversationFallback} font={m.fonts.body} color={c.muted} numberOfLines={0} />
          ) : null}

          {local.metrics.length > 0 && (
            <view width="100%" flexDirection="row" flexWrap="wrap" gap={8}>
              {local.metrics.forEach((metric, idx) => {
                <view
                  key={`local-metric-${idx}`}
                  flexGrow={1}
                  flexBasis={110}
                  minWidth={96}
                  paddingLeft={12}
                  paddingRight={12}
                  paddingTop={10}
                  paddingBottom={10}
                  borderRadius={10}
                  backgroundColor={c.recessed}
                  borderWidth={0.5}
                  borderColor={c.border}
                  gap={3}
                >
                  <label value={metric.label} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
                  <label value={metric.value} font={systemSemiboldFont(16)} color={c.ink} numberOfLines={1} />
                </view>;
              })}
            </view>
          )}

          {local.observedAtText && (
            <label value={local.observedAtText} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
          )}
        </view>
      </SettingsGroup>

      {local.serverLedgerNote && (
        <Banner id="oc-usage-local-note" tone="info" title={local.serverLedgerNote} touch={touch} dark={dark} />
      )}
    </view>;
  }

  private renderLedger(ledger: TokenUsageLedgerSection, dark: boolean, narrow: boolean, touch?: boolean): void {
    const c = themeColors(dark);
    const m = themeMetrics(touch);

    <view width="100%" gap={32}>
      {/* Filter Toolbar Card */}
      <SettingsGroup
        title=""
        clip={!this.state.modelMenuOpen}
        zIndex={this.state.modelMenuOpen ? 50 : 1}
        touch={touch}
        dark={dark}
      >
        <view
          width="100%"
          paddingLeft={16}
          paddingRight={16}
          paddingTop={14}
          paddingBottom={14}
          flexDirection="row"
          flexWrap="wrap"
          alignItems="flex-end"
          justifyContent="space-between"
          gap={14}
        >
          <view flexDirection="row" flexWrap="wrap" alignItems="flex-end" gap={14} flexGrow={1} minWidth={0}>
            {ledger.scopeOptions.length > 1 && (
              <view gap={5}>
                <label value={ledger.scopeLabel} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
                <SegmentedControl
                  id="oc-ledger-scope"
                  label={ledger.scopeLabel}
                  value={ledger.scopeValue}
                  options={ledger.scopeOptions}
                  compact={true}
                  touch={touch}
                  dark={dark}
                  onChange={(val) => ledger.onChangeScope(val)}
                />
              </view>
            )}

            <view gap={5}>
              <label value={ledger.rangeLabel} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
              <SegmentedControl
                id="oc-ledger-range"
                label={ledger.rangeLabel}
                value={ledger.rangeValue}
                options={ledger.rangeOptions}
                compact={true}
                touch={touch}
                dark={dark}
                onChange={(val) => ledger.onChangeRange(val)}
              />
            </view>

            <view gap={5} zIndex={this.state.modelMenuOpen ? 70 : 1}>
              <label value={ledger.modelLabel} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
              <SelectMenu
                id="oc-ledger-model"
                label={ledger.modelLabel}
                value={ledger.modelValue}
                options={ledger.modelOptions}
                open={this.state.modelMenuOpen}
                minWidth={168}
                align="left"
                touch={touch}
                dark={dark}
                onOpenChange={(open) => this.setState({ modelMenuOpen: open })}
                onChange={(val) => ledger.onChangeModel(val)}
              />
            </view>
          </view>
        </view>

        {ledger.customRange && (
          <view width="100%">
            <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
            <view
              width="100%"
              paddingLeft={16}
              paddingRight={16}
              paddingTop={12}
              paddingBottom={14}
              flexDirection={narrow ? "column" : "row"}
              gap={12}
            >
              <view flexGrow={1} flexBasis={0} minWidth={0}>
                <TextField
                  id="oc-ledger-from"
                  label={ledger.customRange.fromLabel}
                  value={ledger.customRange.fromValue}
                  touch={touch}
                  dark={dark}
                  onChange={(val) => ledger.customRange?.onChangeFrom(val)}
                />
              </view>
              <view flexGrow={1} flexBasis={0} minWidth={0}>
                <TextField
                  id="oc-ledger-through"
                  label={ledger.customRange.throughLabel}
                  value={ledger.customRange.throughValue}
                  touch={touch}
                  dark={dark}
                  onChange={(val) => ledger.customRange?.onChangeThrough(val)}
                />
              </view>
            </view>
          </view>
        )}
      </SettingsGroup>

      {/* 5-Cell Key Metrics Strip */}
      {ledger.metrics && ledger.metrics.length > 0 && (
        <SettingsGroup title={ledger.summaryTitle ?? ""} description={ledger.summarySubtitle} touch={touch} dark={dark}>
          <view width="100%" padding={14} gap={12}>
            {ledger.partialBadge && (
              <view
                alignSelf="flex-start"
                paddingLeft={8}
                paddingRight={8}
                paddingTop={2}
                paddingBottom={2}
                borderRadius={999}
                backgroundColor={c.warningSurface}
              >
                <label value={ledger.partialBadge} font={m.fonts.caption} color={c.warning} numberOfLines={1} />
              </view>
            )}
            <view width="100%" flexDirection="row" flexWrap="wrap" gap={8}>
              {ledger.metrics.forEach((cell) => {
                <view
                  key={cell.id}
                  flexGrow={1}
                  flexBasis={narrow ? 140 : 120}
                  minWidth={112}
                  paddingLeft={12}
                  paddingRight={12}
                  paddingTop={12}
                  paddingBottom={12}
                  borderRadius={10}
                  backgroundColor={c.recessed}
                  borderWidth={0.5}
                  borderColor={c.border}
                  gap={3}
                >
                  <label value={cell.value} font={systemSemiboldFont(20)} color={c.ink} numberOfLines={1} />
                  <label value={cell.label} font={m.fonts.detail} color={c.muted} numberOfLines={1} />
                  <label value={cell.detail} font={m.fonts.caption} color={c.disabled} numberOfLines={1} />
                </view>;
              })}
            </view>
            {ledger.summaryMeta && (
              <label value={ledger.summaryMeta} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
            )}
          </view>
        </SettingsGroup>
      )}

      {/* Token Activity Heatmap / Bars */}
      {ledger.activityTitle && (ledger.heatmapWeeks || ledger.bars) && (
        <SettingsGroup title="" touch={touch} dark={dark}>
          <view width="100%" padding={16} gap={14}>
            <view
              width="100%"
              flexDirection={narrow ? "column" : "row"}
              alignItems={narrow ? "flex-start" : "center"}
              justifyContent="space-between"
              gap={12}
            >
              <view gap={3} flexShrink={1} minWidth={0}>
                <label
                  value={ledger.activityTitle}
                  font={m.fonts.sectionTitle}
                  color={c.ink}
                  accessibilityCategory="header"
                />
                {ledger.activitySubtitle && (
                  <label value={ledger.activitySubtitle} font={m.fonts.detail} color={c.muted} numberOfLines={1} />
                )}
              </view>
              <SegmentedControl
                id="oc-ledger-activity-mode"
                label={ledger.activityTitle}
                value={ledger.activityMode}
                options={ledger.activityModeOptions}
                compact={true}
                touch={touch}
                dark={dark}
                onChange={(mode) => ledger.onChangeActivityMode(mode)}
              />
            </view>

            {ledger.activityMode === "daily" && ledger.heatmapWeeks ? (
              <view width="100%" gap={8}>
                <view width="100%" flexDirection="row" gap={8} alignItems="flex-start">
                  {ledger.weekdayLabels && (
                    <view gap={3} paddingTop={2}>
                      {ledger.weekdayLabels.forEach((day, i) => {
                        <view key={`wd-${i}`} height={12} justifyContent="center">
                          <label value={day} font={systemSemiboldFont(10)} color={c.disabled} numberOfLines={1} />
                        </view>;
                      })}
                    </view>
                  )}
                  <view flexDirection="row" flexWrap="wrap" gap={3} flexGrow={1} minWidth={0}>
                    {ledger.heatmapWeeks.forEach((week) => {
                      <view key={week.key} gap={3}>
                        {week.cells.forEach((cell) => {
                          <view
                            key={cell.date}
                            accessibilityId={`oc-heat-${cell.date}`}
                            accessibilityLabel={cell.summaryText}
                            accessibilityCategory={cell.outside ? undefined : "button"}
                            onTap={
                              cell.outside
                                ? undefined
                                : () => {
                                    triggerHaptic("selection");
                                    this.setState({ selectedCellSummary: cell.summaryText });
                                  }
                            }
                            width={12}
                            height={12}
                            borderRadius={3}
                            backgroundColor={cell.outside ? "rgba(0,0,0,0)" : this.heatColor(cell.level, dark)}
                            opacity={cell.outside ? 0.25 : 1}
                          />;
                        })}
                      </view>;
                    })}
                  </view>
                </view>
                <label
                  value={this.state.selectedCellSummary ?? ledger.defaultCellHint ?? ""}
                  font={m.fonts.caption}
                  color={c.muted}
                  numberOfLines={1}
                />
              </view>
            ) : ledger.bars ? (
              <view width="100%" gap={8}>
                {ledger.bars.forEach((bar) => {
                  <view key={bar.key} width="100%" flexDirection="row" alignItems="center" gap={10}>
                    <view width={68} flexShrink={0}>
                      <label value={bar.label} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
                    </view>
                    <view flexGrow={1} flexShrink={1} minWidth={0}>
                      {this.renderInlineTrack(bar.progress, c.success, c.trackSoft)}
                    </view>
                    <view width={68} flexShrink={0} alignItems="flex-end">
                      <label value={bar.valueText} font={m.fonts.caption} color={c.ink} numberOfLines={1} />
                    </view>
                  </view>;
                })}
              </view>
            ) : null}
          </view>
        </SettingsGroup>
      )}

      {/* Model Share Section */}
      {ledger.modelSectionTitle && (
        <SettingsGroup title={ledger.modelSectionTitle} touch={touch} dark={dark}>
          {ledger.modelCards && ledger.modelCards.length > 0 ? (
            <view width="100%" padding={12} flexDirection="row" flexWrap="wrap" gap={10}>
              {ledger.modelCards.forEach((model) => {
                <view
                  key={model.key}
                  flexGrow={1}
                  flexBasis={narrow ? 240 : 210}
                  minWidth={180}
                  padding={12}
                  borderRadius={10}
                  backgroundColor={c.recessed}
                  borderWidth={0.5}
                  borderColor={c.border}
                  gap={8}
                >
                  <view width="100%" flexDirection="row" alignItems="center" justifyContent="space-between" gap={8}>
                    <label value={model.label} font={m.fonts.control} color={c.ink} flexShrink={1} numberOfLines={1} />
                    <label value={model.tokensText} font={m.fonts.controlCompact} color={c.ink} numberOfLines={1} />
                  </view>
                  {this.renderInlineTrack(model.progress, c.success, c.trackSoft)}
                  <label value={model.turnsText} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
                </view>;
              })}
            </view>
          ) : (
            <view width="100%" padding={16}>
              <label value={ledger.modelEmptyText ?? "—"} font={m.fonts.body} color={c.muted} numberOfLines={0} />
            </view>
          )}
        </SettingsGroup>
      )}

      {/* Detailed Conversations / Turns / People */}
      {ledger.detailTitle && (
        <SettingsGroup title={ledger.detailTitle} touch={touch} dark={dark}>
          <view
            width="100%"
            paddingLeft={16}
            paddingRight={16}
            paddingTop={12}
            paddingBottom={12}
            flexDirection="row"
            flexWrap="wrap"
            alignItems="center"
            justifyContent="space-between"
            gap={10}
          >
            {ledger.backToSummaryLabel && ledger.onBackToSummary ? (
              <Button
                id="oc-ledger-back"
                title={ledger.backToSummaryLabel}
                variant="secondary"
                size="sm"
                touch={touch}
                dark={dark}
                onPress={ledger.onBackToSummary}
              />
            ) : ledger.viewOptions && ledger.viewValue && ledger.onChangeView ? (
              <SegmentedControl
                id="oc-ledger-view"
                label={ledger.viewLabel ?? ledger.detailTitle}
                value={ledger.viewValue}
                options={ledger.viewOptions}
                compact={true}
                touch={touch}
                dark={dark}
                onChange={(v) => ledger.onChangeView?.(v)}
              />
            ) : null}

            {ledger.clearActorLabel && ledger.onClearActor && (
              <Button
                id="oc-ledger-clear-actor"
                title={ledger.clearActorLabel}
                variant="ghost"
                size="sm"
                touch={touch}
                dark={dark}
                onPress={ledger.onClearActor}
              />
            )}
          </view>

          <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />

          {ledger.turnRows && ledger.turnRows.length > 0 ? (
            <view width="100%">
              {ledger.turnRows.forEach((turn, idx) => {
                <SettingsListItem
                  key={turn.key}
                  id={`oc-turn-${turn.key}`}
                  title={turn.title}
                  description={turn.subtitle}
                  metadata={turn.detail}
                  divider={idx > 0}
                  touch={touch}
                  dark={dark}
                />;
              })}
            </view>
          ) : ledger.rows && ledger.rows.length > 0 ? (
            <view width="100%">
              {ledger.rows.forEach((row, idx) => {
                <SettingsListItem
                  key={row.key}
                  id={`oc-row-${row.key}`}
                  title={row.title}
                  metadata={row.turnsText}
                  divider={idx > 0}
                  touch={touch}
                  dark={dark}
                  onOpen={row.interactive && ledger.onSelectRow ? () => ledger.onSelectRow?.(row.key) : undefined}
                >
                  <label value={row.tokensText} font={m.fonts.controlCompact} color={c.ink} numberOfLines={1} />
                </SettingsListItem>;
              })}
            </view>
          ) : (
            <view width="100%" padding={16}>
              <label value={ledger.detailEmptyText ?? "—"} font={m.fonts.body} color={c.muted} numberOfLines={0} />
            </view>
          )}

          {(ledger.firstPageLabel || ledger.nextPageLabel) && (
            <view width="100%">
              <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
              <view width="100%" padding={12} flexDirection="row" justifyContent="flex-end" gap={8}>
                {ledger.firstPageLabel && ledger.onFirstPage && (
                  <Button
                    id="oc-ledger-first-page"
                    title={ledger.firstPageLabel}
                    variant="secondary"
                    size="sm"
                    touch={touch}
                    dark={dark}
                    onPress={ledger.onFirstPage}
                  />
                )}
                {ledger.nextPageLabel && ledger.onNextPage && (
                  <Button
                    id="oc-ledger-next-page"
                    title={ledger.nextPageLabel}
                    variant="secondary"
                    size="sm"
                    touch={touch}
                    dark={dark}
                    onPress={ledger.onNextPage}
                  />
                )}
              </view>
            </view>
          )}
        </SettingsGroup>
      )}

      {/* Runtime Diagnostics Disclosure */}
      {ledger.diagnosticsTitle && ledger.diagnosticsToggleLabel && (
        <SettingsGroup title={ledger.diagnosticsTitle} touch={touch} dark={dark}>
          <view width="100%" padding={6}>
            <view
              class="oc-settings-row"
              accessibilityId="oc-ledger-diagnostics-toggle"
              accessibilityLabel={ledger.diagnosticsToggleLabel}
              accessibilityCategory="button"
              accessibilityStateSelected={this.state.diagnosticsOpen}
              onTap={() => {
                triggerHaptic("selection");
                this.setState({ diagnosticsOpen: !this.state.diagnosticsOpen });
              }}
              paddingLeft={10}
              paddingRight={10}
              paddingTop={10}
              paddingBottom={10}
              borderRadius={10}
              flexDirection="row"
              alignItems="center"
              justifyContent="space-between"
              gap={12}
            >
              <label value={ledger.diagnosticsToggleLabel} font={m.fonts.rowTitle} color={c.ink} numberOfLines={1} />
              <Icon name={this.state.diagnosticsOpen ? "chevronUp" : "chevronDown"} size={14} color={c.muted} />
            </view>
          </view>

          {this.state.diagnosticsOpen && (
            <view width="100%">
              <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
              <view width="100%" padding={16} gap={12}>
                {(ledger.collectionStatusText || ledger.collectionActionLabel) && (
                  <view width="100%" flexDirection="row" alignItems="center" justifyContent="space-between" gap={12}>
                    {ledger.collectionStatusText && (
                      <label
                        value={ledger.collectionStatusText}
                        font={m.fonts.control}
                        color={c.ink}
                        numberOfLines={1}
                      />
                    )}
                    {ledger.collectionActionLabel && ledger.onToggleCollection && (
                      <Button
                        id="oc-ledger-toggle-collection"
                        title={ledger.collectionActionLabel}
                        variant="secondary"
                        size="sm"
                        touch={touch}
                        dark={dark}
                        onPress={ledger.onToggleCollection}
                      />
                    )}
                  </view>
                )}

                {ledger.diagnosticsLines?.forEach((line, idx) => {
                  <label key={`diag-${idx}`} value={line} font={m.fonts.detail} color={c.muted} numberOfLines={0} />;
                })}

                {ledger.diagnosticsPartialNotice && (
                  <Banner
                    id="oc-ledger-partial"
                    tone="warning"
                    title={ledger.diagnosticsPartialNotice}
                    touch={touch}
                    dark={dark}
                  />
                )}

                {ledger.categoryStats && ledger.categoryStats.length > 0 && (
                  <view width="100%" flexDirection="row" flexWrap="wrap" gap={8}>
                    {ledger.categoryStats.forEach((stat, idx) => {
                      <view
                        key={`cat-${idx}`}
                        paddingLeft={10}
                        paddingRight={10}
                        paddingTop={8}
                        paddingBottom={8}
                        borderRadius={8}
                        backgroundColor={c.recessed}
                        borderWidth={0.5}
                        borderColor={c.border}
                        gap={2}
                      >
                        <label value={stat.label} font={m.fonts.caption} color={c.muted} numberOfLines={1} />
                        <label value={stat.value} font={m.fonts.control} color={c.ink} numberOfLines={1} />
                      </view>;
                    })}
                  </view>
                )}
              </view>
            </view>
          )}
        </SettingsGroup>
      )}
    </view>;
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const m = themeMetrics(vm.touch);

    <view width="100%">
      {this.state.modelMenuOpen && (
        <view
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          zIndex={30}
          onTap={() => this.setState({ modelMenuOpen: false })}
          accessibilityNavigation="ignored"
        />
      )}

      <view width="100%" gap={36}>
        <SettingsPageHeader title={vm.title} description={vm.subtitle} touch={vm.touch} dark={dark}>
          <Button
            id="oc-token-usage-refresh"
            title={vm.refreshLabel}
            variant="secondary"
            size="sm"
            disabled={vm.loading}
            touch={vm.touch}
            dark={dark}
            onPress={vm.onRefresh}
          />
        </SettingsPageHeader>

        {vm.errorMessage && (
          <Banner id="oc-token-usage-error" tone="danger" title={vm.errorMessage} touch={vm.touch} dark={dark} />
        )}

        {vm.loading && !vm.localUsage && !vm.ledger && vm.loadingText && (
          <view width="100%" paddingTop={8}>
            <label value={vm.loadingText} font={m.fonts.body} color={c.muted} numberOfLines={1} />
          </view>
        )}

        {vm.localUsage && this.renderLocalUsage(vm.localUsage, dark, vm.touch)}
        {vm.ledger && this.renderLedger(vm.ledger, dark, Boolean(vm.narrow), vm.touch)}
      </view>
    </view>;
  }
}
