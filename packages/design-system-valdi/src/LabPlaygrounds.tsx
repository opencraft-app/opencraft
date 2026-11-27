import { Component } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { PageControl } from "./PageControl";
import { ProgressBar } from "./ProgressBar";
import { SegmentedControl } from "./SegmentedControl";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { Slider } from "./Slider";
import { Stepper } from "./Stepper";
import { colorSwatches, LabPageId, StyleLabCopy } from "./StyleLabData";
import { TabBar } from "./TabBar";
import { TextField } from "./TextField";
import { Toggle } from "./Toggle";
import { ColorTokens, radii, themeColors, type } from "./tokens";

export type LabState = {
  page: LabPageId;
  dark: boolean;
  btnVariant: "primary" | "quiet" | "danger";
  btnDisabled: boolean;
  btnLongText: boolean;
  btnClicks: number;
  toggleVal: boolean;
  toggleDisabled: boolean;
  stepperVal: number;
  stepperStep: number;
  sliderVal: number;
  sliderGlyphs: boolean;
  sliderDisabled: boolean;
  sliderStep: number;
  segmentCount: number;
  segmentVal: string;
  segmentDisabled: boolean;
  tfMode: "default" | "password" | "url";
  tfValue: string;
  tfError: boolean;
  tfDisabled: boolean;
  tfReveal: boolean;
  tabCount: number;
  tabBadge: boolean;
  tabVal: string;
  pageCount: number;
  pageCurrent: number;
  pageBg: boolean;
  rowSelected: string;
  rowDetail: boolean;
  bannerTone: "info" | "success" | "warning" | "danger";
  bannerAction: boolean;
  bannerDismiss: boolean;
  bannerShown: boolean;
  overlayDestructive: boolean;
  overlayMessage: boolean;
  emptyAction: boolean;
};

type Props = {
  state: LabState;
  copy: StyleLabCopy;
  onPatch(patch: Partial<LabState>): void;
  onOpenDialog(): void;
  onOpenSheet(): void;
};

/** Renders the Stage + Inspector playground for a selected Style Lab component. */
export class LabPlayground extends Component<Props> {
  private get c(): ColorTokens {
    return themeColors(this.viewModel.state.dark);
  }

  private stage(title: string, renderContent: () => void): void {
    const c = this.c;
    <view gap={10}>
      <label value={title} color={c.ink} font={type.section} accessibilityCategory="header" />
      <view
        class="oc-settings-group"
        padding={20}
        borderRadius={radii.group}
        backgroundColor={c.surface}
        borderWidth={0.5}
        borderColor={c.border}
        alignItems="center"
        justifyContent="center"
        gap={12}
      >
        {renderContent()}
      </view>
    </view>;
  }

  private inspectorRow(rowLabel: string, right: () => void, divider = false): void {
    const c = this.c;
    <view>
      {divider && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
      <view
        minHeight={52}
        paddingLeft={16}
        paddingRight={16}
        paddingTop={6}
        paddingBottom={6}
        flexDirection="row"
        alignItems="center"
        gap={8}
      >
        <label value={rowLabel} font={type.body} color={c.ink} flexGrow={1} flexShrink={1} />
        {right()}
      </view>
    </view>;
  }

  onRender(): void {
    const { state, copy: t, onPatch, onOpenDialog, onOpenSheet } = this.viewModel;
    const c = this.c;
    const dark = state.dark;

    if (state.page === "foundation") {
      const swatches = colorSwatches(c);
      <view gap={20}>
        <SettingsGroup title={t.colorTokensTitle} dark={dark}>
          {swatches.map((s, i) => (
            <view key={s.name}>
              {i > 0 && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
              <view minHeight={50} paddingLeft={16} paddingRight={16} flexDirection="row" alignItems="center" gap={12}>
                <view
                  width={28}
                  height={28}
                  borderRadius={8}
                  backgroundColor={s.value}
                  borderWidth={0.5}
                  borderColor={c.border}
                />
                <label value={s.name} font={type.body} color={c.ink} flexGrow={1} />
                <label value={s.value} font={type.detail} color={c.muted} />
              </view>
            </view>
          ))}
        </SettingsGroup>
        <view gap={10}>
          <label value={t.liquidGlassTestTitle} color={c.ink} font={type.section} accessibilityCategory="header" />
          <view
            height={128}
            borderRadius={radii.group}
            backgroundColor={c.accent}
            padding={16}
            justifyContent="center"
            alignItems="center"
            slowClipping={true}
          >
            <view
              position="absolute"
              top={-18}
              left={-12}
              width={110}
              height={110}
              borderRadius={55}
              backgroundColor={c.success}
              opacity={0.85}
            />
            <view
              position="absolute"
              bottom={-24}
              right={-10}
              width={120}
              height={120}
              borderRadius={60}
              backgroundColor={c.danger}
              opacity={0.75}
            />
            <glass
              class={dark ? "oc-liquid-glass oc-dark" : "oc-liquid-glass"}
              width="100%"
              height={76}
              borderRadius={26}
              glassStyle="regular"
              glassTintColor={dark ? "rgba(28, 28, 32, 0.24)" : "rgba(255, 255, 255, 0.18)"}
              borderWidth={0.5}
              borderColor={dark ? "rgba(255, 255, 255, 0.14)" : "rgba(255, 255, 255, 0.45)"}
              justifyContent="center"
              alignItems="center"
            >
              <label value={t.liquidGlassSurfaceLabel} font={type.section} color={c.ink} />
            </glass>
          </view>
        </view>
        <SettingsGroup title={t.typographyTitle} dark={dark}>
          <view padding={16} gap={8}>
            <label value={t.typoDisplay} font={type.display} color={c.ink} />
            <label value={t.typoSection} font={type.section} color={c.ink} />
            <label value={t.typoBody} font={type.body} color={c.ink} />
            <label value={t.typoButton} font={type.button} color={c.accent} />
            <label value={t.typoDetail} font={type.detail} color={c.muted} />
          </view>
        </SettingsGroup>
      </view>;
      return;
    }

    if (state.page === "button") {
      const btnTitle = state.btnLongText ? t.btnLongTitle : t.btnActionTitle(state.btnClicks);
      const variantOpts = [
        { id: "primary", title: "Primary" },
        { id: "quiet", title: "Quiet" },
        { id: "danger", title: "Danger" },
      ];
      this.stage(t.stageHeader, () => {
        <Button
          id="lab-btn-preview"
          title={btnTitle}
          variant={state.btnVariant}
          disabled={state.btnDisabled}
          dark={dark}
          onPress={() => onPatch({ btnClicks: state.btnClicks + 1 })}
        />;
      });
      <view gap={10}>
        <label value={t.inspectorHeader} color={c.ink} font={type.section} accessibilityCategory="header" />
        <SegmentedControl
          id="lab-btn-variant"
          label={t.btnVariantLabel}
          value={state.btnVariant}
          dark={dark}
          options={variantOpts}
          onChange={(v) => onPatch({ btnVariant: v as LabState["btnVariant"] })}
        />
      </view>;
      <SettingsGroup title={t.stateTogglesHeader} dark={dark}>
        {this.inspectorRow(t.disabledLabel, () => (
          <Toggle
            id="lab-btn-disabled"
            label={t.disabledShort}
            value={state.btnDisabled}
            dark={dark}
            onChange={(btnDisabled) => onPatch({ btnDisabled })}
          />
        ))}
        {this.inspectorRow(
          t.btnLongTextOption,
          () => (
            <Toggle
              id="lab-btn-long"
              label={t.btnLongTextOption}
              value={state.btnLongText}
              dark={dark}
              onChange={(btnLongText) => onPatch({ btnLongText })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    if (state.page === "toggle-stepper") {
      this.stage(t.stageHeader, () => {
        <view width="100%" flexDirection="row" justifyContent="space-around" alignItems="center">
          <Toggle
            id="toggle-auto-sync"
            label={t.sampleToggleLabel}
            value={state.toggleVal}
            disabled={state.toggleDisabled}
            dark={dark}
            onChange={(toggleVal) => onPatch({ toggleVal })}
          />
          <Stepper
            id="stepper-retry"
            label={t.sampleStepperLabel}
            value={state.stepperVal}
            min={0}
            max={10}
            step={state.stepperStep}
            disabled={state.toggleDisabled}
            dark={dark}
            onChange={(stepperVal) => onPatch({ stepperVal })}
          />
        </view>;
        <label value={t.toggleStepperStatus(state.toggleVal, state.stepperVal)} font={type.detail} color={c.muted} />;
      });
      <SettingsGroup title={t.inspectorHeader} dark={dark}>
        {this.inspectorRow(t.disabledLabel, () => (
          <Toggle
            id="lab-ts-disabled"
            label={t.disabledShort}
            value={state.toggleDisabled}
            dark={dark}
            onChange={(toggleDisabled) => onPatch({ toggleDisabled })}
          />
        ))}
        {this.inspectorRow(
          t.stepperStepLabel,
          () => (
            <Stepper
              id="lab-ts-step"
              label={t.stepperStepShort}
              value={state.stepperStep}
              min={1}
              max={5}
              dark={dark}
              onChange={(stepperStep) => onPatch({ stepperStep })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    if (state.page === "slider") {
      const pctText = `${state.sliderVal}%`;
      this.stage(t.stageHeader, () => {
        <view width="100%" gap={14}>
          <Slider
            id="slider-quality"
            label={t.brightnessLabel}
            value={state.sliderVal}
            min={0}
            max={100}
            step={state.sliderStep}
            disabled={state.sliderDisabled}
            dark={dark}
            minIcon={state.sliderGlyphs ? "sunDim" : undefined}
            maxIcon={state.sliderGlyphs ? "sunMax" : undefined}
            onChange={(sliderVal) => onPatch({ sliderVal })}
          />
          <ProgressBar
            id="progress-sync"
            label={t.linkedProgressLabel}
            progress={state.sliderVal / 100}
            detail={pctText}
            dark={dark}
          />
        </view>;
      });
      <SettingsGroup title={t.inspectorHeader} dark={dark}>
        {this.inspectorRow(t.endpointGlyphsLabel, () => (
          <Toggle
            id="lab-slider-glyphs"
            label={t.endpointGlyphsShort}
            value={state.sliderGlyphs}
            dark={dark}
            onChange={(sliderGlyphs) => onPatch({ sliderGlyphs })}
          />
        ))}
        {this.inspectorRow(
          t.disabledLabel,
          () => (
            <Toggle
              id="lab-slider-disabled"
              label={t.disabledShort}
              value={state.sliderDisabled}
              dark={dark}
              onChange={(sliderDisabled) => onPatch({ sliderDisabled })}
            />
          ),
          true,
        )}
        {this.inspectorRow(
          t.stepValueLabel(state.sliderStep),
          () => (
            <Stepper
              id="lab-slider-step"
              label={t.stepperStepShort}
              value={state.sliderStep}
              min={1}
              max={20}
              step={4}
              dark={dark}
              onChange={(sliderStep) => onPatch({ sliderStep })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    if (state.page === "segmented") {
      const opts = state.segmentCount === 2 ? t.segmentOptions2 : t.segmentOptions3;
      this.stage(t.stageHeader, () => {
        <view width="100%" gap={10}>
          <SegmentedControl
            id="activity-view"
            label={t.segmentLabLabel}
            value={state.segmentVal}
            options={opts}
            disabled={state.segmentDisabled}
            dark={dark}
            onChange={(segmentVal) => onPatch({ segmentVal })}
          />
          <label
            value={t.segmentSelectedText(state.segmentVal)}
            font={type.detail}
            color={c.muted}
            textAlign="center"
          />
        </view>;
      });
      <SettingsGroup title={t.inspectorHeader} dark={dark}>
        {this.inspectorRow(t.segmentCountLabel, () => (
          <Stepper
            id="lab-seg-count"
            label={t.segmentCountShort}
            value={state.segmentCount}
            min={2}
            max={3}
            dark={dark}
            onChange={(segmentCount) => onPatch({ segmentCount, segmentVal: "overview" })}
          />
        ))}
        {this.inspectorRow(
          t.disabledLabel,
          () => (
            <Toggle
              id="lab-seg-disabled"
              label={t.disabledShort}
              value={state.segmentDisabled}
              dark={dark}
              onChange={(segmentDisabled) => onPatch({ segmentDisabled })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    if (state.page === "textfield") {
      const tfPlaceholder =
        state.tfMode === "url"
          ? t.tfUrlPlaceholder
          : state.tfMode === "password"
            ? t.tfPasswordPlaceholder
            : t.tfDefaultPlaceholder;
      const tfErr = state.tfError ? t.tfErrorText : undefined;
      const rightTitle = state.tfMode === "password" ? (state.tfReveal ? t.tfHideTitle : t.tfShowTitle) : undefined;
      this.stage(t.stageHeader, () => {
        <view width="100%">
          <TextField
            id="lab-textfield-preview"
            label={t.tfInputLabel}
            value={state.tfValue}
            placeholder={tfPlaceholder}
            error={tfErr}
            hint={t.tfHintText}
            clearTitle={t.tfClearTitle}
            disabled={state.tfDisabled}
            dark={dark}
            contentType={
              state.tfMode === "password"
                ? state.tfReveal
                  ? "passwordVisible"
                  : "password"
                : state.tfMode === "url"
                  ? "url"
                  : "noSuggestions"
            }
            rightActionTitle={rightTitle}
            rightActionDisabled={!state.tfValue}
            onRightAction={() => onPatch({ tfReveal: !state.tfReveal })}
            onChange={(tfValue) => onPatch({ tfValue })}
          />
        </view>;
      });
      <view gap={10}>
        <label value={t.tfModeHeader} color={c.ink} font={type.section} accessibilityCategory="header" />
        <SegmentedControl
          id="lab-tf-mode"
          label={t.tfModeHeader}
          value={state.tfMode}
          dark={dark}
          options={t.tfModeOptions}
          onChange={(v) => onPatch({ tfMode: v as LabState["tfMode"] })}
        />
      </view>;
      <SettingsGroup title={t.stateTogglesHeader} dark={dark}>
        {this.inspectorRow(t.tfShowErrorLabel, () => (
          <Toggle
            id="lab-tf-error"
            label={t.tfErrorShort}
            value={state.tfError}
            dark={dark}
            onChange={(tfError) => onPatch({ tfError })}
          />
        ))}
        {this.inspectorRow(
          t.disabledLabel,
          () => (
            <Toggle
              id="lab-tf-disabled"
              label={t.disabledShort}
              value={state.tfDisabled}
              dark={dark}
              onChange={(tfDisabled) => onPatch({ tfDisabled })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    if (state.page === "tabbar") {
      const items = t.tabPreviewItems(state.tabCount, state.tabBadge);
      this.stage(t.stageHeader, () => {
        <view width="100%" gap={10}>
          <TabBar
            id="lab-tabbar-preview"
            label={t.tabPreviewLabel}
            items={items}
            value={state.tabVal}
            dark={dark}
            onChange={(tabVal) => onPatch({ tabVal })}
          />
          <label value={t.tabActiveText(state.tabVal)} font={type.detail} color={c.muted} textAlign="center" />
        </view>;
      });
      <SettingsGroup title={t.inspectorHeader} dark={dark}>
        {this.inspectorRow(t.tabCountLabel, () => (
          <Stepper
            id="lab-tab-count"
            label={t.tabCountShort}
            value={state.tabCount}
            min={2}
            max={4}
            dark={dark}
            onChange={(tabCount) => onPatch({ tabCount, tabVal: "home" })}
          />
        ))}
        {this.inspectorRow(
          t.tabBadgeLabel,
          () => (
            <Toggle
              id="lab-tab-badge"
              label={t.tabBadgeShort}
              value={state.tabBadge}
              dark={dark}
              onChange={(tabBadge) => onPatch({ tabBadge })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    if (state.page === "page-control") {
      this.stage(t.stageHeader, () => {
        <PageControl
          id="gallery-pages"
          label={t.pageLabLabel}
          count={state.pageCount}
          current={state.pageCurrent}
          showBackground={state.pageBg}
          dark={dark}
          onChange={(pageCurrent) => onPatch({ pageCurrent })}
        />;
        <label value={t.pageStatusText(state.pageCurrent, state.pageCount)} font={type.detail} color={c.muted} />;
      });
      <SettingsGroup title={t.inspectorHeader} dark={dark}>
        {this.inspectorRow(t.pageTotalLabel, () => (
          <Stepper
            id="lab-pc-count"
            label={t.pageTotalShort}
            value={state.pageCount}
            min={2}
            max={7}
            dark={dark}
            onChange={(pageCount) => onPatch({ pageCount, pageCurrent: Math.min(state.pageCurrent, pageCount - 1) })}
          />
        ))}
        {this.inspectorRow(
          t.pageCapsuleBgLabel,
          () => (
            <Toggle
              id="lab-pc-bg"
              label={t.pageCapsuleBgShort}
              value={state.pageBg}
              dark={dark}
              onChange={(pageBg) => onPatch({ pageBg })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    if (state.page === "settings-group") {
      const d1 = state.rowDetail ? t.rowModelDetail : undefined;
      const d2 = state.rowDetail ? t.rowNoticeDetail : undefined;
      const d3 = state.rowDetail ? t.rowLockedDetail : undefined;
      <SettingsGroup title={t.stageHeader} dark={dark}>
        <SettingsRow
          id="lab-row-1"
          title={t.rowModelPref}
          detail={d1}
          selected={state.rowSelected === "a"}
          dark={dark}
          onSelect={() => onPatch({ rowSelected: "a" })}
        />
        <SettingsRow
          id="lab-row-2"
          title={t.rowNoticePref}
          detail={d2}
          selected={state.rowSelected === "b"}
          divider={true}
          dark={dark}
          onSelect={() => onPatch({ rowSelected: "b" })}
        />
        <SettingsRow
          id="lab-row-3"
          title={t.rowLockedPref}
          detail={d3}
          disabled={true}
          divider={true}
          dark={dark}
          onSelect={() => {}}
        />
      </SettingsGroup>;
      <SettingsGroup title={t.inspectorHeader} dark={dark}>
        {this.inspectorRow(t.rowShowDetailLabel, () => (
          <Toggle
            id="lab-row-detail"
            label={t.rowDetailShort}
            value={state.rowDetail}
            dark={dark}
            onChange={(rowDetail) => onPatch({ rowDetail })}
          />
        ))}
      </SettingsGroup>;
      return;
    }

    if (state.page === "banner") {
      const actTitle = state.bannerAction ? t.bannerActionTitle : undefined;
      const toneOpts = [
        { id: "info", title: "Info" },
        { id: "success", title: "Success" },
        { id: "warning", title: "Warn" },
        { id: "danger", title: "Danger" },
      ];
      this.stage(t.stageHeader, () => {
        <view width="100%">
          {state.bannerShown ? (
            <Banner
              id="gallery-banner"
              tone={state.bannerTone}
              title={t.bannerPreviewTitle}
              message={t.bannerPreviewMessage}
              actionTitle={actTitle}
              onAction={state.bannerAction ? () => onOpenSheet() : undefined}
              onDismiss={state.bannerDismiss ? () => onPatch({ bannerShown: false }) : undefined}
              dark={dark}
            />
          ) : (
            <Button
              id="restore-banner"
              title={t.bannerRestoreTitle}
              variant="quiet"
              dark={dark}
              onPress={() => onPatch({ bannerShown: true })}
            />
          )}
        </view>;
      });
      <view gap={10}>
        <label value={t.bannerToneHeader} color={c.ink} font={type.section} accessibilityCategory="header" />
        <SegmentedControl
          id="lab-banner-tone"
          label={t.bannerToneShort}
          value={state.bannerTone}
          dark={dark}
          options={toneOpts}
          onChange={(v) => onPatch({ bannerTone: v as LabState["bannerTone"], bannerShown: true })}
        />
      </view>;
      <SettingsGroup title={t.bannerVisibilityHeader} dark={dark}>
        {this.inspectorRow(t.bannerShowActionLabel, () => (
          <Toggle
            id="lab-banner-action"
            label={t.bannerActionShort}
            value={state.bannerAction}
            dark={dark}
            onChange={(bannerAction) => onPatch({ bannerAction })}
          />
        ))}
        {this.inspectorRow(
          t.bannerShowDismissLabel,
          () => (
            <Toggle
              id="lab-banner-dismiss"
              label={t.bannerDismissShort}
              value={state.bannerDismiss}
              dark={dark}
              onChange={(bannerDismiss) => onPatch({ bannerDismiss })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    if (state.page === "overlays") {
      this.stage(t.stageHeader, () => {
        <view width="100%" flexDirection="row" gap={10}>
          <view flexGrow={1} flexBasis={0}>
            <Button id="lab-open-sheet" title={t.openSheetBtn} dark={dark} onPress={onOpenSheet} />
          </view>
          <view flexGrow={1} flexBasis={0}>
            <Button
              id="lab-open-dialog"
              title={t.openDialogBtn}
              variant={state.overlayDestructive ? "danger" : "quiet"}
              dark={dark}
              onPress={onOpenDialog}
            />
          </view>
        </view>;
      });
      <SettingsGroup title={t.inspectorHeader} dark={dark}>
        {this.inspectorRow(t.destructiveModeLabel, () => (
          <Toggle
            id="lab-overlay-destructive"
            label={t.destructiveShort}
            value={state.overlayDestructive}
            dark={dark}
            onChange={(overlayDestructive) => onPatch({ overlayDestructive })}
          />
        ))}
        {this.inspectorRow(
          t.subtitleOptionLabel,
          () => (
            <Toggle
              id="lab-overlay-message"
              label={t.subtitleShort}
              value={state.overlayMessage}
              dark={dark}
              onChange={(overlayMessage) => onPatch({ overlayMessage })}
            />
          ),
          true,
        )}
      </SettingsGroup>;
      return;
    }

    const emptyAct = state.emptyAction ? t.emptyPreviewAction : undefined;
    this.stage(t.stageHeader, () => {
      <view width="100%">
        <EmptyState
          id="gallery-empty"
          title={t.emptyPreviewTitle}
          description={t.emptyPreviewDesc}
          actionTitle={emptyAct}
          dark={dark}
          onAction={() => onPatch({ pageCurrent: 0 })}
        />
      </view>;
    });
    <SettingsGroup title={t.inspectorHeader} dark={dark}>
      {this.inspectorRow(t.emptyShowActionLabel, () => (
        <Toggle
          id="lab-empty-action"
          label={t.emptyActionShort}
          value={state.emptyAction}
          dark={dark}
          onChange={(emptyAction) => onPatch({ emptyAction })}
        />
      ))}
    </SettingsGroup>;
  }
}
