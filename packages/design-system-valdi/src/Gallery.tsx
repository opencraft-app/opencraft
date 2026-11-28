import { StatefulComponent } from "valdi_core/src/Component";
import { systemSemiboldFont } from "valdi_core/src/SystemFont";
import { ActionSheet } from "./ActionSheet";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { LabPlayground, LabState } from "./LabPlaygrounds";
import { SegmentedControl } from "./SegmentedControl";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { LabPageId, resolveStyleLabCopy, StyleLabCopy } from "./StyleLabData";
import { TabBar } from "./TabBar";
import { TextField } from "./TextField";
import { Toggle } from "./Toggle";
import { ColorTokens, radii, themeColors, type } from "./tokens";
import { registerHapticHandler, triggerHaptic } from "./haptics";

export type GalleryProps = {
  dark?: boolean;
  locale?: string;
  layoutMode?: "auto" | "split" | "compact";
  safeAreaTop?: number;
  safeAreaBottom?: number;
  keyboardHeight?: number;
  onHaptic?: (style: string) => void;
  onThemeChange?: (dark: boolean) => void;
};

type State = {
  viewportWidth: number;
  view: string;
  detailPage?: LabPageId;
  setting: string;
  segment: string;
  name: string;
  savedName: string;
  error?: string;
  saved: boolean;
  confirming: boolean;
  removed: boolean;
  sheetOpen: boolean;
  modelCategory: string;
  modelPrimary: string;
  modelApiKey: string;
  revealApiKey: boolean;
  modelTested?: "success" | "error";
  deletingModel?: string;
  searchQuery: string;
  pressingCatalogId?: LabPageId;
  pageEntered: boolean;
  navDirection: "forward" | "back" | "tab";
  swipeBackX: number;
  lab: LabState;
};

export class Gallery extends StatefulComponent<GalleryProps, State> {
  state: State = {
    viewportWidth: 960,
    view: "controls",
    setting: "workspace",
    segment: "overview",
    name: "",
    savedName: "Studio",
    saved: false,
    confirming: false,
    removed: false,
    sheetOpen: false,
    modelCategory: "coding_plan",
    modelPrimary: "Claude 4.5 Sonnet",
    modelApiKey: "",
    revealApiKey: false,
    searchQuery: "",
    pageEntered: true,
    navDirection: "forward",
    swipeBackX: 0,
    lab: {
      page: "foundation",
      dark: false,
      btnVariant: "primary",
      btnDisabled: false,
      btnLongText: false,
      btnClicks: 0,
      toggleVal: true,
      toggleDisabled: false,
      stepperVal: 2,
      stepperStep: 1,
      sliderVal: 65,
      sliderGlyphs: true,
      sliderDisabled: false,
      sliderStep: 5,
      segmentCount: 3,
      segmentVal: "overview",
      segmentDisabled: false,
      tfMode: "default",
      tfValue: "",
      tfError: false,
      tfDisabled: false,
      tfReveal: false,
      tabCount: 3,
      tabBadge: true,
      tabVal: "home",
      pageCount: 4,
      pageCurrent: 1,
      pageBg: true,
      rowSelected: "a",
      rowDetail: true,
      bannerTone: "info",
      bannerAction: true,
      bannerDismiss: true,
      bannerShown: true,
      overlayDestructive: true,
      overlayMessage: true,
      emptyAction: true,
    },
  };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
    if (this.viewModel.dark !== undefined && this.viewModel.dark !== this.state.lab.dark) {
      this.setState({ lab: { ...this.state.lab, dark: this.viewModel.dark } });
    }
  }

  onViewModelUpdate(previous?: Readonly<GalleryProps>): void {
    registerHapticHandler(this.viewModel.onHaptic);
    if (
      this.viewModel.dark !== undefined &&
      this.viewModel.dark !== previous?.dark &&
      this.viewModel.dark !== this.state.lab.dark
    ) {
      this.setState({ lab: { ...this.state.lab, dark: this.viewModel.dark } });
    }
  }

  private get t(): StyleLabCopy {
    return resolveStyleLabCopy(this.viewModel.locale);
  }

  private get c(): ColorTokens {
    return themeColors(this.state.lab.dark);
  }

  private isWide(): boolean {
    if (this.viewModel.layoutMode === "split") return true;
    if (this.viewModel.layoutMode === "compact") return false;
    return this.state.viewportWidth >= 760;
  }

  private patchLab(patch: Partial<LabState>): void {
    if (patch.dark !== undefined) {
      this.viewModel.onThemeChange?.(patch.dark);
    }
    this.setState({ lab: { ...this.state.lab, ...patch } });
  }

  private saveName(): void {
    const name = this.state.name.trim();
    const length = Array.from(name).length;
    if (length < 2 || length > 30) {
      this.setState({ error: this.t.workspaceLengthError, saved: false });
      return;
    }
    this.setState({ savedName: name, error: undefined, saved: true });
  }

  private navigateWithTransition(patch: Partial<State>, direction: "forward" | "back" | "tab"): void {
    this.setState({ ...patch, pageEntered: false, navDirection: direction, swipeBackX: 0 });
    setTimeout(() => {
      if (this.isDestroyed()) return;
      this.animate({ stiffness: 360, damping: 32 }, () => {
        this.setState({ pageEntered: true });
      });
    }, 16);
  }

  private popSubpage(): void {
    const inNotifications = this.state.view === "example" && this.state.setting === "notifications";
    if (inNotifications) {
      this.navigateWithTransition({ setting: "workspace" }, "back");
      return;
    }
    if (this.state.detailPage) {
      this.navigateWithTransition({ detailPage: undefined }, "back");
      return;
    }
    this.navigateWithTransition({ view: "controls" }, "back");
  }

  private openCatalogItem(id: LabPageId, wide: boolean): void {
    if (id === "example") {
      this.navigateWithTransition(
        { view: "example", setting: "workspace", detailPage: undefined },
        wide ? "tab" : "forward",
      );
      return;
    }
    if (id === "model") {
      this.navigateWithTransition({ view: "model", detailPage: undefined }, wide ? "tab" : "forward");
      return;
    }
    if (wide) {
      this.setState({ view: "controls", detailPage: undefined, lab: { ...this.state.lab, page: id } });
      return;
    }
    this.navigateWithTransition({ view: "controls", detailPage: id, lab: { ...this.state.lab, page: id } }, "forward");
  }

  private catalogList(wide: boolean): void {
    const t = this.t;
    const activeId: LabPageId =
      this.state.view === "example" ? "example" : this.state.view === "model" ? "model" : this.state.lab.page;
    const dark = this.state.lab.dark;
    const c = this.c;
    const query = this.state.searchQuery.trim().toLowerCase();
    const filtered = t.sections
      .map((section) => ({
        ...section,
        items: query
          ? section.items.filter(
              (item) =>
                item.title.toLowerCase().includes(query) ||
                item.subtitle.toLowerCase().includes(query) ||
                item.id.toLowerCase().includes(query),
            )
          : section.items,
      }))
      .filter((section) => section.items.length > 0);
    <TextField
      id="catalog-search"
      label={t.searchLabel}
      hideLabel={true}
      leadingIcon="search"
      clearTitle={t.clearLabel}
      placeholder={t.searchPlaceholder}
      value={this.state.searchQuery}
      dark={dark}
      onChange={(searchQuery) => this.setState({ searchQuery })}
    />;
    {
      filtered.length === 0 && (
        <EmptyState
          id="catalog-empty"
          icon="sparkle"
          title={t.emptySearchTitle}
          description={t.emptySearchDescription}
          actionTitle={t.emptySearchAction}
          dark={dark}
          onAction={() => this.setState({ searchQuery: "" })}
        />
      );
    }
    {
      filtered.forEach((section) => {
        <SettingsGroup key={section.title} title={section.title} dark={dark}>
          {section.items.forEach((item, index) => {
            const selected = wide && activeId === item.id;
            const pressing = this.state.pressingCatalogId === item.id;
            <view key={item.id}>
              {index > 0 && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
              <view paddingLeft={5} paddingRight={5} paddingTop={3} paddingBottom={3}>
                <view
                  class="oc-settings-row"
                  accessibilityId={`catalog-${item.id}`}
                  accessibilityLabel={item.title}
                  accessibilityCategory="button"
                  accessibilityStateSelected={selected}
                  onTouchStart={() => this.setState({ pressingCatalogId: item.id })}
                  onTouchEnd={() => this.setState({ pressingCatalogId: undefined })}
                  onTap={() => {
                    this.setState({ pressingCatalogId: undefined });
                    this.openCatalogItem(item.id, wide);
                  }}
                  minHeight={42}
                  paddingLeft={8}
                  paddingRight={8}
                  paddingTop={6}
                  paddingBottom={6}
                  borderRadius={9}
                  flexDirection="row"
                  alignItems="center"
                  gap={10}
                  backgroundColor={selected ? c.navCurrent : pressing ? c.trackSubtle : undefined}
                >
                  <view
                    width={28}
                    height={28}
                    borderRadius={7}
                    backgroundColor={selected ? c.primaryButton : c.recessed}
                    borderWidth={0.5}
                    borderColor={c.border}
                    alignItems="center"
                    justifyContent="center"
                    accessibilityNavigation="ignored"
                  >
                    <Icon name={item.icon} size={14} color={selected ? c.primaryButtonForeground : c.muted} />
                  </view>
                  <view flexGrow={1} flexShrink={1} minWidth={0} gap={2}>
                    <label value={item.title} font={type.body} color={c.ink} numberOfLines={1} />
                    <label value={item.subtitle} font={type.detail} color={c.muted} numberOfLines={1} />
                  </view>
                  {!wide && <Icon name="chevronRight" size={14} color={c.disabled} />}
                </view>
              </view>
            </view>;
          })}
        </SettingsGroup>;
      });
    }
  }

  private groupedList(groupTitle: string): void {
    const t = this.t;
    const { setting } = this.state;
    const dark = this.state.lab.dark;
    <SettingsGroup title={groupTitle} dark={dark}>
      <SettingsRow
        id="setting-workspace"
        title={t.workspaceRowTitle}
        detail={this.state.savedName}
        selected={setting === "workspace"}
        dark={dark}
        onSelect={() => this.setState({ setting: "workspace" })}
      />
      <SettingsRow
        id="setting-notifications"
        title={t.notificationsTitle}
        detail={t.notificationsDetail}
        selected={setting === "notifications"}
        divider={true}
        dark={dark}
        onSelect={() => this.navigateWithTransition({ setting: "notifications" }, "forward")}
      />
      <SettingsRow
        id="setting-advanced"
        title={t.advancedSettingsTitle}
        detail={t.advancedSettingsDetail}
        disabled={true}
        divider={true}
        dark={dark}
        onSelect={() => {}}
      />
    </SettingsGroup>;
  }

  private segmentDemo(sectionTitle: string): void {
    const t = this.t;
    const c = this.c;
    const dark = this.state.lab.dark;
    const content = t.segmentContent[this.state.segment] ?? t.segmentContent.overview;
    <view gap={10}>
      <label value={sectionTitle} color={c.ink} font={type.section} accessibilityCategory="header" />
      <SegmentedControl
        id="activity-view"
        label={sectionTitle}
        value={this.state.segment}
        options={t.segmentOptions3}
        dark={dark}
        onChange={(segment) => this.setState({ segment })}
      />
    </view>;
    <view accessibilityStateLiveRegion={true}>
      <SettingsGroup title={content.title} dark={dark}>
        {content.items.forEach((item, index) => {
          <view key={item.title}>
            {index > 0 && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
            <view flexDirection="row" minHeight={52} paddingLeft={16} paddingRight={16} alignItems="center" gap={8}>
              <label value={item.title} font={type.body} color={c.ink} flexGrow={1} flexShrink={1} />
              <label value={item.detail} font={type.body} color={c.muted} />
            </view>
          </view>;
        })}
      </SettingsGroup>
    </view>;
  }

  private inputDemo(): void {
    const t = this.t;
    const state = this.state;
    const c = this.c;
    const dark = state.lab.dark;
    <view gap={8}>
      <view flexDirection="row" justifyContent="space-between" alignItems="center">
        <label value={t.workspaceNameLabel} color={c.ink} font={type.section} accessibilityCategory="header" />
        <view
          accessibilityId="save-name"
          accessibilityCategory="button"
          accessibilityLabel={t.saveNameLabel}
          minHeight={32}
          justifyContent="center"
          paddingLeft={10}
          paddingRight={4}
          onTap={() => this.saveName()}
        >
          <label value={t.saveShort} color={c.accent} font={type.button} />
        </view>
      </view>
      <TextField
        id="workspace-name"
        label={t.workspaceNameLabel}
        value={state.name}
        error={state.error}
        hideLabel={true}
        dark={dark}
        placeholder={t.workspacePlaceholder}
        hint={t.workspaceHint}
        clearTitle={t.workspaceClearTitle}
        onChange={(name) => this.setState({ name, error: undefined, saved: false })}
        onSubmit={() => this.saveName()}
      />
      {state.saved && (
        <label value={t.workspaceSavedLabel} color={c.accent} font={type.detail} accessibilityStateLiveRegion={true} />
      )}
    </view>;
  }

  private removalDemo(groupTitle: string): void {
    const t = this.t;
    const { removed } = this.state;
    const dark = this.state.lab.dark;
    const c = this.c;
    const id = removed ? "restore-project" : "remove-project";
    const actionAria = removed ? t.restoreSampleLabel : t.removeProjectLabel;
    const actionLabel = removed ? t.restoreSampleLabel : t.removeDraftLabel;
    const onPress = () => (removed ? this.setState({ removed: false }) : this.setState({ confirming: true }));
    <SettingsGroup title={groupTitle} dark={dark}>
      <view
        accessibilityId={id}
        accessibilityCategory="button"
        accessibilityLabel={actionAria}
        onTap={onPress}
        minHeight={52}
        alignItems="center"
        justifyContent="center"
        padding={12}
      >
        <label value={actionLabel} color={removed ? c.accent : c.danger} font={type.body} />
      </view>
    </SettingsGroup>;
  }

  private examplePage(): void {
    const t = this.t;
    const c = this.c;
    if (this.state.setting === "workspace") {
      <label value={t.workspaceSettingsTitle} color={c.ink} font={type.display} accessibilityCategory="header" />;
      this.inputDemo();
      this.groupedList(t.preferencesTitle);
      this.removalDemo(t.projectsGroupTitle);
    } else {
      <label value={t.notificationsTitle} color={c.ink} font={type.display} accessibilityCategory="header" />;
      this.segmentDemo(t.notificationViewTitle);
    }
  }

  private modelPreviewPage(): void {
    const t = this.t;
    const state = this.state;
    const dark = state.lab.dark;
    const c = this.c;
    const catalogByCategory: Record<string, ReadonlyArray<{ title: string; provider: string }>> = {
      coding_plan: [
        { title: "Claude 4.5 Sonnet", provider: "Anthropic" },
        { title: "GPT-5.1 Codex", provider: "OpenAI" },
        { title: "Gemini 3 Pro", provider: "Google" },
      ],
      api: [
        { title: "DeepSeek-V3.2", provider: "DeepSeek" },
        { title: "Qwen3-Coder-Plus", provider: "Alibaba Cloud" },
        { title: "GLM-4.7", provider: "Zhipu AI" },
      ],
      custom: [
        { title: "Local vLLM · Qwen3-32B", provider: "Localhost :8000" },
        { title: "Custom OpenAI Endpoint", provider: "Self-Hosted" },
      ],
    };
    const models = catalogByCategory[state.modelCategory] ?? catalogByCategory.coding_plan;
    const activeProvider = models.find((m) => m.title === state.modelPrimary)?.provider ?? t.brandTitle;
    const subMeta = `${activeProvider} · ${t.mockPreviewSuffix}`;
    const rightAction = state.revealApiKey ? t.tfHideTitle : t.tfShowTitle;
    const bannerTitle = state.modelTested === "success" ? t.modelCheckPassed : t.modelKeyRequired;
    const bannerMsg = state.modelTested === "success" ? `${state.modelPrimary} · 142 ms` : t.modelMockHint;

    <label value={t.modelConfigTitle} color={c.ink} font={type.display} accessibilityCategory="header" />;
    <view
      padding={16}
      gap={4}
      borderRadius={radii.group}
      backgroundColor={c.accentSoft}
      borderWidth={0.5}
      borderColor={c.border}
    >
      <label
        value={t.currentDefaultModel}
        color={c.accent}
        font={systemSemiboldFont(12)}
        accessibilityCategory="header"
      />
      <label value={state.modelPrimary} color={c.ink} font={systemSemiboldFont(18)} numberOfLines={0} />
      <label value={subMeta} color={c.muted} font={type.detail} />
    </view>;
    <SegmentedControl
      id="preview-model-category"
      label={t.modelCategoryLabel}
      value={state.modelCategory}
      options={t.modelCategories}
      dark={dark}
      onChange={(modelCategory) => {
        const list = catalogByCategory[modelCategory] ?? catalogByCategory.coding_plan;
        this.setState({ modelCategory, modelPrimary: list[0].title, modelTested: undefined });
      }}
    />;
    <SettingsGroup title={t.configuredModelsTitle} dark={dark}>
      {models.map((item, index) => {
        const rowDetail = state.modelPrimary === item.title ? t.primaryModelBadge : undefined;
        return (
          <SettingsRow
            key={item.title}
            id={`preview-model-${index}`}
            title={item.title}
            detail={rowDetail}
            selected={state.modelPrimary === item.title}
            divider={index > 0}
            dark={dark}
            onSelect={() => this.setState({ modelPrimary: item.title })}
          />
        );
      })}
    </SettingsGroup>;
    <SettingsGroup title={t.credentialsTitle} dark={dark}>
      <TextField
        id="preview-model-key"
        label={t.apiKeyLabel}
        value={state.modelApiKey}
        placeholder={t.tfPasswordPlaceholder}
        hideLabel={true}
        inline={true}
        dark={dark}
        contentType={state.revealApiKey ? "passwordVisible" : "password"}
        autocapitalization="none"
        rightActionTitle={rightAction}
        rightActionDisabled={!state.modelApiKey}
        onRightAction={() => this.setState({ revealApiKey: !state.revealApiKey })}
        onChange={(modelApiKey) => this.setState({ modelApiKey, modelTested: undefined })}
      />
      <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
      <SettingsRow
        id="preview-model-test"
        title={t.checkModelStatusTitle}
        divider={false}
        dark={dark}
        onSelect={() => this.setState({ modelTested: state.modelApiKey.trim() ? "success" : "error" })}
      />
    </SettingsGroup>;
    {
      state.modelTested && (
        <Banner
          id="preview-model-banner"
          tone={state.modelTested === "success" ? "success" : "danger"}
          title={bannerTitle}
          message={bannerMsg}
          dark={dark}
          onDismiss={() => this.setState({ modelTested: undefined })}
        />
      );
    }
    <Button
      id="preview-model-delete"
      title={t.deleteModelBtn}
      variant="danger"
      dark={dark}
      onPress={() => this.setState({ deletingModel: state.modelPrimary })}
    />;
  }

  private exampleToolbar(wide: boolean): void {
    const t = this.t;
    const { setting, confirming, sheetOpen, view } = this.state;
    const safeTop = this.viewModel.safeAreaTop ?? 0;
    const dark = this.state.lab.dark;
    const c = this.c;
    const inNotifications = view === "example" && setting === "notifications";
    const navTitle = inNotifications ? t.workspaceSettingsTitle : t.styleLabTitle;
    const backAria = `${t.backPrefix} ${navTitle}`;
    const modalOpen = confirming || sheetOpen || !!this.state.deletingModel;
    <view
      class={dark ? "oc-example-toolbar oc-dark" : "oc-example-toolbar"}
      position="absolute"
      top={0}
      left={wide ? 290 : 0}
      right={0}
      zIndex={4}
      paddingTop={safeTop}
      alignItems="center"
      opacity={this.state.pageEntered ? 1 : 0}
      translationY={this.state.pageEntered ? 0 : -6}
      accessibilityId="example-toolbar"
      accessibilityNavigation={modalOpen ? "ignored" : "auto"}
    >
      <view
        width="100%"
        maxWidth={wide ? 680 : 468}
        height={52}
        paddingLeft={wide ? 28 : 16}
        paddingRight={wide ? 28 : 16}
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
      >
        <view marginLeft={-8}>
          <view
            class="oc-ghost-button"
            accessibilityId="example-back"
            accessibilityCategory="button"
            accessibilityLabel={backAria}
            minHeight={30}
            borderRadius={7}
            paddingLeft={8}
            paddingRight={10}
            gap={6}
            flexDirection="row"
            alignItems="center"
            onTap={() => this.popSubpage()}
          >
            <Icon name="arrowLeft" size={14} color={c.muted} />
            <label value={navTitle} color={c.muted} font={type.body} />
          </view>
        </view>
        <label value={t.brandTitle} color={c.muted} font={type.detail} />
      </view>
    </view>;
  }

  private renderDetailTitle(): void {
    const page = this.state.lab.page;
    const c = this.c;
    const item = this.t.sections.flatMap((s) => s.items).find((i) => i.id === page);
    if (!item) return;
    <view gap={4}>
      <label value={item.title} color={c.ink} font={type.display} accessibilityCategory="header" />
      <label value={item.subtitle} color={c.muted} font={type.detail} />
    </view>;
  }

  private renderActivePlayground(): void {
    <LabPlayground
      state={this.state.lab}
      copy={this.t}
      onPatch={(patch) => this.patchLab(patch)}
      onOpenDialog={() => this.setState({ confirming: true })}
      onOpenSheet={() => this.setState({ sheetOpen: true })}
    />;
  }

  private renderCompact(): void {
    const t = this.t;
    const state = this.state;
    const safeTop = this.viewModel.safeAreaTop ?? 0;
    const safeBottom = this.viewModel.safeAreaBottom ?? 0;
    const keyboardHeight = this.viewModel.keyboardHeight ?? 0;
    const c = this.c;
    const dark = state.lab.dark;
    const subpage = !!state.detailPage || (state.view === "example" && state.setting === "notifications");
    const isCatalogRoot = state.view === "controls" && !state.detailPage;
    const modalOpen = state.confirming || state.sheetOpen || !!state.deletingModel;
    const tx = state.pageEntered
      ? state.swipeBackX
      : state.navDirection === "forward"
        ? 38
        : state.navDirection === "back"
          ? -26
          : 0;
    const ty = state.pageEntered ? 0 : state.navDirection === "tab" ? 8 : 0;
    const swipeOpacity = state.swipeBackX > 0 ? Math.max(0.28, 1 - state.swipeBackX / 360) : 1;
    const pageOpacity = state.pageEntered ? swipeOpacity : state.navDirection === "tab" ? 0.65 : 0;
    const emblemLetter = "O";

    <scroll
      key={state.view === "example" ? state.setting : (state.detailPage ?? state.view)}
      accessibilityId="style-lab-content"
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      scrollEnabled={!modalOpen}
      touchEnabled={!modalOpen}
      accessibilityNavigation={modalOpen ? "ignored" : "auto"}
    >
      <view
        width="100%"
        maxWidth={468}
        alignSelf="center"
        paddingLeft={16}
        paddingRight={16}
        paddingTop={subpage ? safeTop + 68 : safeTop + 20}
        paddingBottom={Math.max(safeBottom + 104, keyboardHeight + 24)}
        gap={subpage ? 24 : 20}
        translationX={tx}
        translationY={ty}
        opacity={pageOpacity}
      >
        {!subpage && (
          <view flexDirection="row" alignItems="center" justifyContent="space-between" gap={10}>
            <view flexDirection="row" alignItems="center" gap={9}>
              <view
                width={26}
                height={26}
                borderRadius={8}
                backgroundColor={c.ink}
                alignItems="center"
                justifyContent="center"
                accessibilityNavigation="ignored"
              >
                <label value={emblemLetter} font={systemSemiboldFont(15)} color={c.canvas} />
              </view>
              <label value={t.brandTitle} font={systemSemiboldFont(15)} color={c.ink} />
            </view>
            <view flexDirection="row" alignItems="center" gap={6}>
              <label value={t.darkShort} font={type.detail} color={c.muted} />
              <Toggle
                id="toggle-dark-mode"
                label={t.darkModeLabel}
                value={dark}
                dark={dark}
                onChange={(nextDark) => this.patchLab({ dark: nextDark })}
              />
            </view>
          </view>
        )}
        {isCatalogRoot && (
          <view gap={4}>
            <label value={t.styleLabTitle} color={c.ink} font={type.display} accessibilityCategory="header" />
            <label value={t.styleLabSubtitle} color={c.muted} font={type.detail} />
          </view>
        )}
        {state.view === "example" ? (
          this.examplePage()
        ) : state.view === "model" ? (
          this.modelPreviewPage()
        ) : state.detailPage ? (
          <view gap={20}>
            {this.renderDetailTitle()}
            {this.renderActivePlayground()}
          </view>
        ) : (
          this.catalogList(false)
        )}
      </view>
    </scroll>;
    {
      subpage && this.exampleToolbar(false);
    }
    {
      subpage && !modalOpen && (
        <view
          position="absolute"
          top={safeTop + 56}
          bottom={0}
          left={0}
          width={28}
          zIndex={5}
          accessibilityNavigation="ignored"
          onDrag={(event) => {
            const dx = Math.max(0, event.deltaX);
            if (event.state === 2) {
              if (dx > 88 || event.velocityX > 420) {
                triggerHaptic("light");
                this.popSubpage();
              } else {
                this.animate({ stiffness: 360, damping: 32 }, () => {
                  this.setState({ swipeBackX: 0 });
                });
              }
              return;
            }
            this.setState({ swipeBackX: dx });
          }}
        />
      );
    }
    {
      !subpage && keyboardHeight <= 0 && (
        <view
          accessibilityId="gallery-tabbar-wrap"
          position="absolute"
          bottom={Math.max(14, safeBottom - 10)}
          left={0}
          right={0}
          zIndex={4}
          alignItems="center"
          accessibilityNavigation={modalOpen ? "ignored" : "auto"}
        >
          <view width="100%" maxWidth={340} paddingLeft={16} paddingRight={16}>
            <TabBar
              id="gallery-tabbar"
              label={t.tabBarLabel}
              items={t.tabs}
              value={state.view}
              dark={dark}
              onChange={(view) =>
                this.navigateWithTransition(
                  view === "example"
                    ? { view, setting: "workspace", detailPage: undefined }
                    : { view, detailPage: undefined },
                  "tab",
                )
              }
            />
          </view>
        </view>
      );
    }
  }

  private renderSplit(): void {
    const t = this.t;
    const state = this.state;
    const safeTop = this.viewModel.safeAreaTop ?? 0;
    const safeBottom = this.viewModel.safeAreaBottom ?? 0;
    const keyboardHeight = this.viewModel.keyboardHeight ?? 0;
    const c = this.c;
    const dark = state.lab.dark;
    const inNotifications = state.view === "example" && state.setting === "notifications";
    const modalOpen = state.confirming || state.sheetOpen || !!state.deletingModel;
    const emblemLetter = "O";

    <view width="100%" height="100%" flexDirection="row">
      <view width={290} height="100%" backgroundColor={c.surface} accessibilityId="style-lab-sidebar">
        <scroll flexGrow={1} flexBasis={0} minHeight={0}>
          <view
            paddingLeft={14}
            paddingRight={14}
            paddingTop={safeTop + 20}
            paddingBottom={Math.max(safeBottom + 28, keyboardHeight + 24)}
            gap={18}
          >
            <view flexDirection="row" alignItems="center" justifyContent="space-between">
              <view flexDirection="row" alignItems="center" gap={8}>
                <view
                  width={26}
                  height={26}
                  borderRadius={8}
                  backgroundColor={c.ink}
                  alignItems="center"
                  justifyContent="center"
                  accessibilityNavigation="ignored"
                >
                  <label value={emblemLetter} font={systemSemiboldFont(15)} color={c.canvas} />
                </view>
                <label value={t.styleLabTitle} font={systemSemiboldFont(18)} color={c.ink} />
              </view>
              <Toggle
                id="toggle-dark-mode"
                label={t.darkModeLabel}
                value={dark}
                dark={dark}
                onChange={(nextDark) => this.patchLab({ dark: nextDark })}
              />
            </view>
            {this.catalogList(true)}
          </view>
        </scroll>
      </view>
      <view width={0.5} height="100%" backgroundColor={c.border} />
      <view flexGrow={1} flexBasis={0} minWidth={0} height="100%" backgroundColor={c.canvas}>
        <scroll
          key={state.view === "example" ? state.setting : state.view === "model" ? "model" : state.lab.page}
          accessibilityId="style-lab-content"
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
          scrollEnabled={!modalOpen}
          touchEnabled={!modalOpen}
          accessibilityNavigation={modalOpen ? "ignored" : "auto"}
        >
          <view
            width="100%"
            maxWidth={680}
            alignSelf="center"
            paddingLeft={28}
            paddingRight={28}
            paddingTop={inNotifications ? safeTop + 70 : safeTop + 26}
            paddingBottom={Math.max(safeBottom + 48, keyboardHeight + 24)}
            gap={22}
          >
            {state.view === "example" ? (
              this.examplePage()
            ) : state.view === "model" ? (
              this.modelPreviewPage()
            ) : (
              <view gap={22}>
                {this.renderDetailTitle()}
                {this.renderActivePlayground()}
              </view>
            )}
          </view>
        </scroll>
        {inNotifications && this.exampleToolbar(true)}
      </view>
    </view>;
  }

  onRender(): void {
    const t = this.t;
    const state = this.state;
    const c = this.c;
    const dark = state.lab.dark;
    const wide = this.isWide();
    const dlgTitle = state.view === "example" ? t.removeDraftDialogTitle : t.confirmDialogTitle;
    const dlgMsg =
      state.view === "example"
        ? t.removeDraftDialogMsg
        : state.lab.overlayMessage
          ? t.styleLabDialogMsg
          : t.genericConfirmMsg;
    const dlgConfirm = state.view === "example" ? t.removeProjectBtn : t.confirmBtn;
    const delMsg = state.deletingModel ? t.deleteModelDialogMsg(state.deletingModel) : "";
    const sheetMsg = state.lab.overlayMessage ? t.sheetMessage : undefined;

    <view
      width="100%"
      height="100%"
      backgroundColor={c.canvas}
      onLayout={(frame) => {
        if (frame.width > 0 && Math.abs(frame.width - state.viewportWidth) >= 1) {
          this.setState({ viewportWidth: frame.width });
        }
      }}
    >
      {wide ? this.renderSplit() : this.renderCompact()}
      {state.confirming && (
        <ConfirmDialog
          id="remove-dialog"
          title={dlgTitle}
          message={dlgMsg}
          cancelTitle={t.cancelBtn}
          confirmTitle={dlgConfirm}
          destructive={state.view === "example" ? true : state.lab.overlayDestructive}
          dark={dark}
          onCancel={() => this.setState({ confirming: false })}
          onConfirm={() =>
            this.setState(state.view === "example" ? { confirming: false, removed: true } : { confirming: false })
          }
        />
      )}
      {state.deletingModel && (
        <ConfirmDialog
          id="preview-delete-dialog"
          title={t.deleteModelDialogTitle}
          message={delMsg}
          cancelTitle={t.cancelBtn}
          confirmTitle={t.confirmDeleteBtn}
          destructive={true}
          dark={dark}
          onCancel={() => this.setState({ deletingModel: undefined })}
          onConfirm={() => this.setState({ deletingModel: undefined, modelTested: "success" })}
        />
      )}
      {state.sheetOpen && (
        <ActionSheet
          id="gallery-sheet"
          title={t.sheetTitle}
          message={sheetMsg}
          dark={dark}
          cancelTitle={t.cancelBtn}
          actions={[
            { id: "duplicate", title: t.sheetDuplicate, onPress: () => this.setState({ sheetOpen: false }) },
            { id: "export", title: t.sheetExport, onPress: () => this.setState({ sheetOpen: false }) },
            {
              id: "delete",
              title: t.sheetDelete,
              destructive: state.lab.overlayDestructive,
              onPress: () => this.setState({ sheetOpen: false }),
            },
          ]}
          onCancel={() => this.setState({ sheetOpen: false })}
        />
      )}
    </view>;
  }
}
