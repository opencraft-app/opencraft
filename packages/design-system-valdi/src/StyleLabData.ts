import { IconName } from "./Icon";
import { ColorTokens } from "./tokens";

export type LabPageId =
  | "foundation"
  | "button"
  | "toggle-stepper"
  | "slider"
  | "segmented"
  | "textfield"
  | "tabbar"
  | "page-control"
  | "settings-group"
  | "banner"
  | "overlays"
  | "empty-state"
  | "example"
  | "model";

export type CatalogItem = {
  id: LabPageId;
  title: string;
  subtitle: string;
  icon: IconName;
};

export type CatalogSection = {
  title: string;
  items: readonly CatalogItem[];
};

export type StyleLabCopy = {
  brandTitle: string;
  styleLabTitle: string;
  styleLabSubtitle: string;
  darkShort: string;
  darkModeLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  clearLabel: string;
  emptySearchTitle: string;
  emptySearchDescription: string;
  emptySearchAction: string;
  sections: readonly CatalogSection[];
  tabs: ReadonlyArray<{ id: string; title: string; icon: IconName; badge?: string }>;
  tabBarLabel: string;
  backPrefix: string;
  stageHeader: string;
  inspectorHeader: string;
  stateTogglesHeader: string;
  disabledLabel: string;
  disabledShort: string;
  // Foundation
  colorTokensTitle: string;
  liquidGlassTestTitle: string;
  liquidGlassSurfaceLabel: string;
  typographyTitle: string;
  typoDisplay: string;
  typoSection: string;
  typoBody: string;
  typoButton: string;
  typoDetail: string;
  // Button
  btnVariantLabel: string;
  btnLongTextOption: string;
  btnLongTitle: string;
  btnActionTitle: (clicks: number) => string;
  // Toggle & Stepper
  sampleToggleLabel: string;
  sampleStepperLabel: string;
  toggleStepperStatus: (on: boolean, val: number) => string;
  stepperStepLabel: string;
  stepperStepShort: string;
  // Slider
  brightnessLabel: string;
  linkedProgressLabel: string;
  endpointGlyphsLabel: string;
  endpointGlyphsShort: string;
  stepValueLabel: (step: number) => string;
  // Segmented
  segmentOptions2: ReadonlyArray<{ id: string; title: string }>;
  segmentOptions3: ReadonlyArray<{ id: string; title: string }>;
  segmentLabLabel: string;
  segmentSelectedText: (val: string) => string;
  segmentCountLabel: string;
  segmentCountShort: string;
  // TextField
  tfInputLabel: string;
  tfUrlPlaceholder: string;
  tfPasswordPlaceholder: string;
  tfDefaultPlaceholder: string;
  tfErrorText: string;
  tfHintText: string;
  tfClearTitle: string;
  tfHideTitle: string;
  tfShowTitle: string;
  tfModeHeader: string;
  tfModeOptions: ReadonlyArray<{ id: string; title: string }>;
  tfShowErrorLabel: string;
  tfErrorShort: string;
  // TabBar
  tabPreviewItems: (
    count: number,
    badge: boolean,
  ) => ReadonlyArray<{ id: string; title: string; icon: IconName; badge?: string }>;
  tabPreviewLabel: string;
  tabActiveText: (val: string) => string;
  tabCountLabel: string;
  tabCountShort: string;
  tabBadgeLabel: string;
  tabBadgeShort: string;
  // PageControl
  pageLabLabel: string;
  pageStatusText: (current: number, total: number) => string;
  pageTotalLabel: string;
  pageTotalShort: string;
  pageCapsuleBgLabel: string;
  pageCapsuleBgShort: string;
  // SettingsGroup
  rowModelPref: string;
  rowModelDetail: string;
  rowNoticePref: string;
  rowNoticeDetail: string;
  rowLockedPref: string;
  rowLockedDetail: string;
  rowShowDetailLabel: string;
  rowDetailShort: string;
  // Banner
  bannerPreviewTitle: string;
  bannerPreviewMessage: string;
  bannerActionTitle: string;
  bannerRestoreTitle: string;
  bannerToneHeader: string;
  bannerToneShort: string;
  bannerVisibilityHeader: string;
  bannerShowActionLabel: string;
  bannerActionShort: string;
  bannerShowDismissLabel: string;
  bannerDismissShort: string;
  // Overlays
  openSheetBtn: string;
  openDialogBtn: string;
  destructiveModeLabel: string;
  destructiveShort: string;
  subtitleOptionLabel: string;
  subtitleShort: string;
  // EmptyState
  emptyPreviewTitle: string;
  emptyPreviewDesc: string;
  emptyPreviewAction: string;
  emptyShowActionLabel: string;
  emptyActionShort: string;
  // Example Page
  workspaceSettingsTitle: string;
  preferencesTitle: string;
  projectsGroupTitle: string;
  workspaceRowTitle: string;
  notificationsTitle: string;
  notificationsDetail: string;
  advancedSettingsTitle: string;
  advancedSettingsDetail: string;
  notificationViewTitle: string;
  segmentContent: Record<
    string,
    { title: string; detail: string; items: ReadonlyArray<{ title: string; detail: string }> }
  >;
  workspaceNameLabel: string;
  saveNameLabel: string;
  saveShort: string;
  workspacePlaceholder: string;
  workspaceHint: string;
  workspaceClearTitle: string;
  workspaceSavedLabel: string;
  workspaceLengthError: string;
  restoreSampleLabel: string;
  removeProjectLabel: string;
  removeDraftLabel: string;
  // Model Preview Page
  modelConfigTitle: string;
  currentDefaultModel: string;
  mockPreviewSuffix: string;
  modelCategoryLabel: string;
  modelCategories: ReadonlyArray<{ id: string; title: string }>;
  configuredModelsTitle: string;
  primaryModelBadge: string;
  credentialsTitle: string;
  apiKeyLabel: string;
  checkModelStatusTitle: string;
  modelCheckPassed: string;
  modelKeyRequired: string;
  modelMockHint: string;
  deleteModelBtn: string;
  // Dialogs & Sheets
  removeDraftDialogTitle: string;
  confirmDialogTitle: string;
  removeDraftDialogMsg: string;
  styleLabDialogMsg: string;
  genericConfirmMsg: string;
  cancelBtn: string;
  removeProjectBtn: string;
  confirmBtn: string;
  deleteModelDialogTitle: string;
  deleteModelDialogMsg: (model: string) => string;
  confirmDeleteBtn: string;
  sheetTitle: string;
  sheetMessage: string;
  sheetDuplicate: string;
  sheetExport: string;
  sheetDelete: string;
};

const zhCopy: StyleLabCopy = {
  brandTitle: "OpenCraft",
  styleLabTitle: "Style Lab",
  styleLabSubtitle: "Valdi · 跨端组件库",
  darkShort: "深色",
  darkModeLabel: "深色模式",
  searchLabel: "搜索组件或规范",
  searchPlaceholder: "搜索组件，如 glass / slider / modal",
  clearLabel: "清除",
  emptySearchTitle: "未找到匹配组件",
  emptySearchDescription: "试试搜索 Button、Glass、TabBar 或清空搜索词。",
  emptySearchAction: "清空搜索",
  sections: [
    {
      title: "Foundation 基础规范",
      items: [{ id: "foundation", title: "Tokens & Surface", subtitle: "色板、字阶、圆角与透明材质", icon: "sparkle" }],
    },
    {
      title: "Controls 基础控件",
      items: [
        { id: "button", title: "Button", subtitle: "主按钮、次按钮、危险态与禁用", icon: "plus" },
        { id: "toggle-stepper", title: "Toggle & Stepper", subtitle: "开关与胶囊步进器", icon: "toggle" },
        { id: "slider", title: "Slider & Progress", subtitle: "滑块、端点图标与进度条", icon: "slider" },
        { id: "segmented", title: "Segmented Control", subtitle: "分段选择与指针/触控拖动", icon: "segmented" },
        { id: "textfield", title: "TextField", subtitle: "文本、密码显隐、URL 与校验", icon: "textfield" },
      ],
    },
    {
      title: "Navigation & Lists 导航与列表",
      items: [
        { id: "tabbar", title: "TabBar", subtitle: "悬浮毛玻璃底栏与角标", icon: "tabbar" },
        { id: "page-control", title: "PageControl", subtitle: "圆点分页指示器", icon: "pagecontrol" },
        { id: "settings-group", title: "SettingsGroup", subtitle: "分组容器、设置行与分隔线", icon: "list" },
      ],
    },
    {
      title: "Overlays & Feedback 弹层与反馈",
      items: [
        { id: "banner", title: "Banner", subtitle: "多语义状态横幅与操作", icon: "info" },
        { id: "overlays", title: "ActionSheet & Dialog", subtitle: "毛玻璃操作面板与确认弹层", icon: "sheet" },
        { id: "empty-state", title: "EmptyState", subtitle: "居中空状态与主操作", icon: "sparkle" },
      ],
    },
    {
      title: "Templates 业务样板",
      items: [
        { id: "example", title: "工作区设置", subtitle: "多级导航、通知与移除确认", icon: "home" },
        { id: "model", title: "模型配置", subtitle: "OpenCraft ModelPicker 视觉预览", icon: "gear" },
      ],
    },
  ],
  tabs: [
    { id: "controls", title: "目录", icon: "home" },
    { id: "example", title: "示例", icon: "inbox", badge: "2" },
    { id: "model", title: "模型", icon: "gear" },
  ],
  tabBarLabel: "底部标签栏",
  backPrefix: "返回",
  stageHeader: "PREVIEW STAGE · 实时交互预览",
  inspectorHeader: "INSPECTOR · 参数调节",
  stateTogglesHeader: "状态开关",
  disabledLabel: "禁用态（disabled）",
  disabledShort: "禁用态",
  colorTokensTitle: "语义色板（Color Tokens）",
  liquidGlassTestTitle: "透明材质折射穿透测试",
  liquidGlassSurfaceLabel: "Frosted Surface",
  typographyTitle: "字阶规范（Typography）",
  typoDisplay: "Display · 34pt Semibold",
  typoSection: "Section · 17pt Semibold",
  typoBody: "Body · 17pt Regular",
  typoButton: "Button · 16pt Semibold",
  typoDetail: "Detail · 13pt Regular",
  btnVariantLabel: "按钮变体",
  btnLongTextOption: "多行长文案",
  btnLongTitle: "保存并应用到当前工作区设置",
  btnActionTitle: (clicks) => `操作按钮（已点 ${clicks} 次）`,
  sampleToggleLabel: "示例开关",
  sampleStepperLabel: "示例步进器",
  toggleStepperStatus: (on, val) => `开关：${on ? "开" : "关"} · 数值：${val}`,
  stepperStepLabel: "步进器步长（step）",
  stepperStepShort: "步长",
  brightnessLabel: "亮度调节",
  linkedProgressLabel: "联动进度条",
  endpointGlyphsLabel: "显示端点图标（Glyphs）",
  endpointGlyphsShort: "端点图标",
  stepValueLabel: (step) => `步长：${step}`,
  segmentOptions2: [
    { id: "overview", title: "概览" },
    { id: "archive", title: "归档" },
  ],
  segmentOptions3: [
    { id: "overview", title: "概览" },
    { id: "activity", title: "活动" },
    { id: "archive", title: "归档" },
  ],
  segmentLabLabel: "分段实验",
  segmentSelectedText: (val) => `当前选中：${val}`,
  segmentCountLabel: "分段数量（2 或 3）",
  segmentCountShort: "分段数量",
  tfInputLabel: "输入样例",
  tfUrlPlaceholder: "https://api.example.com",
  tfPasswordPlaceholder: "sk-...",
  tfDefaultPlaceholder: "输入工作区名称",
  tfErrorText: "格式校验未通过，请检查输入内容。",
  tfHintText: "支持清除按钮、错误态和右侧明文切换。",
  tfClearTitle: "清除输入",
  tfHideTitle: "隐藏",
  tfShowTitle: "显示",
  tfModeHeader: "INSPECTOR · 输入类型",
  tfModeOptions: [
    { id: "default", title: "普通文本" },
    { id: "password", title: "密码" },
    { id: "url", title: "URL" },
  ],
  tfShowErrorLabel: "显示错误提示",
  tfErrorShort: "错误提示",
  tabPreviewItems: (count, badge) => [
    { id: "home", title: "概览", icon: "home" },
    { id: "inbox", title: "通知", icon: "inbox", badge: badge ? "2" : undefined },
    ...(count >= 3 ? [{ id: "gear", title: "设置", icon: "gear" as const }] : []),
    ...(count >= 4 ? [{ id: "more", title: "发现", icon: "sparkle" as const }] : []),
  ],
  tabPreviewLabel: "底部标签栏预览",
  tabActiveText: (val) => `当前激活 Tab：${val}`,
  tabCountLabel: "Tab 数量（2–4）",
  tabCountShort: "Tab 数量",
  tabBadgeLabel: "显示通知角标（Badge）",
  tabBadgeShort: "角标",
  pageLabLabel: "分页实验",
  pageStatusText: (cur, total) => `第 ${cur + 1} / ${total} 页`,
  pageTotalLabel: "总页数（2–7）",
  pageTotalShort: "总页数",
  pageCapsuleBgLabel: "显示胶囊底色",
  pageCapsuleBgShort: "胶囊底色",
  rowModelPref: "模型偏好",
  rowModelDetail: "Claude 4.5",
  rowNoticePref: "通知提醒",
  rowNoticeDetail: "仅重要消息",
  rowLockedPref: "只读锁定项",
  rowLockedDetail: "无权限",
  rowShowDetailLabel: "显示右侧详情值",
  rowDetailShort: "详情值",
  bannerPreviewTitle: "状态横幅预览",
  bannerPreviewMessage: "可实时切换语义色调、操作按钮与关闭按钮。",
  bannerActionTitle: "查看",
  bannerRestoreTitle: "恢复横幅",
  bannerToneHeader: "INSPECTOR · 语义色调",
  bannerToneShort: "色调",
  bannerVisibilityHeader: "按钮显隐",
  bannerShowActionLabel: "显示操作按钮",
  bannerActionShort: "操作按钮",
  bannerShowDismissLabel: "显示关闭按钮",
  bannerDismissShort: "关闭按钮",
  openSheetBtn: "弹出 ActionSheet",
  openDialogBtn: "弹出 ConfirmDialog",
  destructiveModeLabel: "危险操作模式（destructive）",
  destructiveShort: "危险操作",
  subtitleOptionLabel: "显示副标题说明",
  subtitleShort: "副标题",
  emptyPreviewTitle: "暂无自定义模板",
  emptyPreviewDesc: "创建或导入组件库模板后，将显示在这里。",
  emptyPreviewAction: "新建模板",
  emptyShowActionLabel: "显示主操作按钮",
  emptyActionShort: "主操作按钮",
  workspaceSettingsTitle: "工作区设置",
  preferencesTitle: "偏好设置",
  projectsGroupTitle: "项目",
  workspaceRowTitle: "工作区",
  notificationsTitle: "通知",
  notificationsDetail: "活动与成员",
  advancedSettingsTitle: "高级设置",
  advancedSettingsDetail: "无管理权限",
  notificationViewTitle: "通知视图",
  segmentContent: {
    overview: {
      title: "工作区概览",
      detail: "最近修改的项目和当前成员。",
      items: [
        { title: "项目更新", detail: "2 条未读" },
        { title: "成员动态", detail: "已读" },
      ],
    },
    activity: {
      title: "最近活动",
      detail: "查看项目更新与成员操作。",
      items: [
        { title: "原型草稿已更新", detail: "今天" },
        { title: "新增一位成员", detail: "昨天" },
      ],
    },
    archive: {
      title: "归档项目",
      detail: "从归档中查看以前的项目。",
      items: [{ title: "工作区搭建", detail: "已归档" }],
    },
  },
  workspaceNameLabel: "工作区名称",
  saveNameLabel: "保存名称",
  saveShort: "保存",
  workspacePlaceholder: "输入名称",
  workspaceHint: "2–30 个字符，保存后会更新设置行。",
  workspaceClearTitle: "清除工作区名称",
  workspaceSavedLabel: "已保存",
  workspaceLengthError: "工作区名称需为 2–30 个字符。",
  restoreSampleLabel: "恢复样例",
  removeProjectLabel: "移除项目",
  removeDraftLabel: "移除原型草稿",
  modelConfigTitle: "模型配置",
  currentDefaultModel: "当前默认模型",
  mockPreviewSuffix: "Mock 预览数据",
  modelCategoryLabel: "模型分类",
  modelCategories: [
    { id: "coding_plan", title: "Coding Plan" },
    { id: "api", title: "模型 API" },
    { id: "custom", title: "自定义" },
  ],
  configuredModelsTitle: "已配置模型",
  primaryModelBadge: "主模型",
  credentialsTitle: "凭据与检测",
  apiKeyLabel: "API Key",
  checkModelStatusTitle: "检测模型状态",
  modelCheckPassed: "模型可用性检测通过",
  modelKeyRequired: "请先输入 API Key",
  modelMockHint: "Mock 校验提示，输入任意字符即可通过。",
  deleteModelBtn: "删除当前模型",
  removeDraftDialogTitle: "移除原型草稿？",
  confirmDialogTitle: "确认操作？",
  removeDraftDialogMsg: "项目会从当前示例工作区移除。",
  styleLabDialogMsg: "这是 Valdi 确认弹层预览。",
  genericConfirmMsg: "确定继续吗？",
  cancelBtn: "取消",
  removeProjectBtn: "移除项目",
  confirmBtn: "确认",
  deleteModelDialogTitle: "删除模型？",
  deleteModelDialogMsg: (model) => `${model}\nMock 示例操作，不会修改真实配置。`,
  confirmDeleteBtn: "确认删除",
  sheetTitle: "原型草稿操作",
  sheetMessage: "选择要对当前组件样例执行的操作。",
  sheetDuplicate: "复制一份",
  sheetExport: "导出 JSON",
  sheetDelete: "移除草稿",
};

const enCopy: StyleLabCopy = {
  brandTitle: "OpenCraft",
  styleLabTitle: "Style Lab",
  styleLabSubtitle: "Valdi · Cross-Platform UI Kit",
  darkShort: "Dark",
  darkModeLabel: "Dark Mode",
  searchLabel: "Search components or specs",
  searchPlaceholder: "Search components, e.g. glass / slider / modal",
  clearLabel: "Clear",
  emptySearchTitle: "No matching components",
  emptySearchDescription: "Try searching Button, Glass, TabBar, or clear the filter.",
  emptySearchAction: "Clear search",
  sections: [
    {
      title: "Foundation",
      items: [
        {
          id: "foundation",
          title: "Tokens & Surface",
          subtitle: "Semantic palette, type scale, radii & surface materials",
          icon: "sparkle",
        },
      ],
    },
    {
      title: "Controls",
      items: [
        { id: "button", title: "Button", subtitle: "Primary, quiet, destructive & disabled states", icon: "plus" },
        {
          id: "toggle-stepper",
          title: "Toggle & Stepper",
          subtitle: "Spring switch & capsule stepper",
          icon: "toggle",
        },
        {
          id: "slider",
          title: "Slider & Progress",
          subtitle: "Continuous slider, endpoint glyphs & progress bar",
          icon: "slider",
        },
        {
          id: "segmented",
          title: "Segmented Control",
          subtitle: "Capsule switcher with pointer/touch drag",
          icon: "segmented",
        },
        { id: "textfield", title: "TextField", subtitle: "Text, password reveal, URL & validation", icon: "textfield" },
      ],
    },
    {
      title: "Navigation & Lists",
      items: [
        { id: "tabbar", title: "TabBar", subtitle: "Floating translucent tab bar with badges", icon: "tabbar" },
        { id: "page-control", title: "PageControl", subtitle: "Capsule dot pagination indicator", icon: "pagecontrol" },
        {
          id: "settings-group",
          title: "SettingsGroup",
          subtitle: "Grouped surface, selection rows & hairlines",
          icon: "list",
        },
      ],
    },
    {
      title: "Overlays & Feedback",
      items: [
        { id: "banner", title: "Banner", subtitle: "Semantic status banners with actions", icon: "info" },
        {
          id: "overlays",
          title: "ActionSheet & Dialog",
          subtitle: "Translucent action sheet & modal dialog",
          icon: "sheet",
        },
        { id: "empty-state", title: "EmptyState", subtitle: "Centered placeholder with primary CTA", icon: "sparkle" },
      ],
    },
    {
      title: "Templates",
      items: [
        {
          id: "example",
          title: "Workspace Settings",
          subtitle: "Nested navigation, notifications & removal dialog",
          icon: "home",
        },
        { id: "model", title: "Model Picker", subtitle: "OpenCraft ModelPicker template preview", icon: "gear" },
      ],
    },
  ],
  tabs: [
    { id: "controls", title: "Catalog", icon: "home" },
    { id: "example", title: "Sample", icon: "inbox", badge: "2" },
    { id: "model", title: "Models", icon: "gear" },
  ],
  tabBarLabel: "Bottom Tab Bar",
  backPrefix: "Back to",
  stageHeader: "PREVIEW STAGE · LIVE INTERACTIVE",
  inspectorHeader: "INSPECTOR · PARAMETERS",
  stateTogglesHeader: "State Toggles",
  disabledLabel: "Disabled state",
  disabledShort: "Disabled",
  colorTokensTitle: "Semantic Color Tokens",
  liquidGlassTestTitle: "Surface Refraction Test",
  liquidGlassSurfaceLabel: "Frosted Surface",
  typographyTitle: "Typography Scale",
  typoDisplay: "Display · 34pt Semibold",
  typoSection: "Section · 17pt Semibold",
  typoBody: "Body · 17pt Regular",
  typoButton: "Button · 16pt Semibold",
  typoDetail: "Detail · 13pt Regular",
  btnVariantLabel: "Button variant",
  btnLongTextOption: "Long multi-word label",
  btnLongTitle: "Save and apply to current workspace",
  btnActionTitle: (clicks) => `Action Button (${clicks} clicks)`,
  sampleToggleLabel: "Sample Toggle",
  sampleStepperLabel: "Sample Stepper",
  toggleStepperStatus: (on, val) => `Toggle: ${on ? "On" : "Off"} · Value: ${val}`,
  stepperStepLabel: "Stepper increment (step)",
  stepperStepShort: "Step",
  brightnessLabel: "Brightness",
  linkedProgressLabel: "Linked Progress",
  endpointGlyphsLabel: "Show endpoint glyphs",
  endpointGlyphsShort: "Glyphs",
  stepValueLabel: (step) => `Step: ${step}`,
  segmentOptions2: [
    { id: "overview", title: "Overview" },
    { id: "archive", title: "Archive" },
  ],
  segmentOptions3: [
    { id: "overview", title: "Overview" },
    { id: "activity", title: "Activity" },
    { id: "archive", title: "Archive" },
  ],
  segmentLabLabel: "Segmented Control",
  segmentSelectedText: (val) => `Selected: ${val}`,
  segmentCountLabel: "Segment count (2 or 3)",
  segmentCountShort: "Segments",
  tfInputLabel: "Sample Input",
  tfUrlPlaceholder: "https://api.example.com",
  tfPasswordPlaceholder: "sk-...",
  tfDefaultPlaceholder: "Enter workspace name",
  tfErrorText: "Validation failed. Please check your input.",
  tfHintText: "Supports clear button, validation error, and password reveal.",
  tfClearTitle: "Clear input",
  tfHideTitle: "Hide",
  tfShowTitle: "Show",
  tfModeHeader: "INSPECTOR · INPUT MODE",
  tfModeOptions: [
    { id: "default", title: "Text" },
    { id: "password", title: "Password" },
    { id: "url", title: "URL" },
  ],
  tfShowErrorLabel: "Show validation error",
  tfErrorShort: "Error state",
  tabPreviewItems: (count, badge) => [
    { id: "home", title: "Home", icon: "home" },
    { id: "inbox", title: "Inbox", icon: "inbox", badge: badge ? "2" : undefined },
    ...(count >= 3 ? [{ id: "gear", title: "Settings", icon: "gear" as const }] : []),
    ...(count >= 4 ? [{ id: "more", title: "Explore", icon: "sparkle" as const }] : []),
  ],
  tabPreviewLabel: "Bottom TabBar Preview",
  tabActiveText: (val) => `Active Tab: ${val}`,
  tabCountLabel: "Tab count (2–4)",
  tabCountShort: "Tabs",
  tabBadgeLabel: "Show notification badge",
  tabBadgeShort: "Badge",
  pageLabLabel: "Pagination",
  pageStatusText: (cur, total) => `Page ${cur + 1} of ${total}`,
  pageTotalLabel: "Total pages (2–7)",
  pageTotalShort: "Pages",
  pageCapsuleBgLabel: "Show capsule platter",
  pageCapsuleBgShort: "Platter",
  rowModelPref: "Model preference",
  rowModelDetail: "Claude 4.5",
  rowNoticePref: "Notifications",
  rowNoticeDetail: "Mentions only",
  rowLockedPref: "Locked row",
  rowLockedDetail: "Read-only",
  rowShowDetailLabel: "Show trailing detail text",
  rowDetailShort: "Detail text",
  bannerPreviewTitle: "Status Banner Preview",
  bannerPreviewMessage: "Switch semantic tones, action buttons, and dismiss controls live.",
  bannerActionTitle: "Inspect",
  bannerRestoreTitle: "Restore Banner",
  bannerToneHeader: "INSPECTOR · SEMANTIC TONE",
  bannerToneShort: "Tone",
  bannerVisibilityHeader: "Button Visibility",
  bannerShowActionLabel: "Show action button",
  bannerActionShort: "Action",
  bannerShowDismissLabel: "Show dismiss button",
  bannerDismissShort: "Dismiss",
  openSheetBtn: "Open ActionSheet",
  openDialogBtn: "Open ConfirmDialog",
  destructiveModeLabel: "Destructive action mode",
  destructiveShort: "Destructive",
  subtitleOptionLabel: "Show descriptive message",
  subtitleShort: "Message",
  emptyPreviewTitle: "No Custom Templates",
  emptyPreviewDesc: "Templates created with the UI Kit will appear here.",
  emptyPreviewAction: "New Template",
  emptyShowActionLabel: "Show primary action button",
  emptyActionShort: "Primary CTA",
  workspaceSettingsTitle: "Workspace Settings",
  preferencesTitle: "Preferences",
  projectsGroupTitle: "Project",
  workspaceRowTitle: "Workspace",
  notificationsTitle: "Notifications",
  notificationsDetail: "Activity & members",
  advancedSettingsTitle: "Advanced",
  advancedSettingsDetail: "No admin access",
  notificationViewTitle: "Notification Feed",
  segmentContent: {
    overview: {
      title: "Workspace Overview",
      detail: "Recently updated projects and active members.",
      items: [
        { title: "Project Updates", detail: "2 unread" },
        { title: "Team Activity", detail: "Up to date" },
      ],
    },
    activity: {
      title: "Recent Activity",
      detail: "Latest edits and member events.",
      items: [
        { title: "Draft prototype updated", detail: "Today" },
        { title: "New member joined", detail: "Yesterday" },
      ],
    },
    archive: {
      title: "Archived Projects",
      detail: "Browse previously archived workspaces.",
      items: [{ title: "Initial workspace setup", detail: "Archived" }],
    },
  },
  workspaceNameLabel: "Workspace Name",
  saveNameLabel: "Save workspace name",
  saveShort: "Save",
  workspacePlaceholder: "Enter name",
  workspaceHint: "2–30 characters; updates the Workspace row above.",
  workspaceClearTitle: "Clear workspace name",
  workspaceSavedLabel: "Saved",
  workspaceLengthError: "Workspace name must be 2–30 characters.",
  restoreSampleLabel: "Restore Sample",
  removeProjectLabel: "Remove Project",
  removeDraftLabel: "Remove Prototype Draft",
  modelConfigTitle: "Model Configuration",
  currentDefaultModel: "Default Model",
  mockPreviewSuffix: "Interactive Preview",
  modelCategoryLabel: "Model Category",
  modelCategories: [
    { id: "coding_plan", title: "Coding Plan" },
    { id: "api", title: "Model API" },
    { id: "custom", title: "Custom" },
  ],
  configuredModelsTitle: "Configured Models",
  primaryModelBadge: "Primary",
  credentialsTitle: "Credentials & Health Check",
  apiKeyLabel: "API Key",
  checkModelStatusTitle: "Verify Model Readiness",
  modelCheckPassed: "Model connectivity verified",
  modelKeyRequired: "Please enter an API Key first",
  modelMockHint: "Mock check — enter any characters above to pass.",
  deleteModelBtn: "Remove Selected Model",
  removeDraftDialogTitle: "Remove Prototype Draft?",
  confirmDialogTitle: "Confirm Action?",
  removeDraftDialogMsg: "This item will be removed from the sample workspace.",
  styleLabDialogMsg: "This is a live Valdi dialog preview.",
  genericConfirmMsg: "Are you sure you want to continue?",
  cancelBtn: "Cancel",
  removeProjectBtn: "Remove",
  confirmBtn: "Confirm",
  deleteModelDialogTitle: "Remove Model?",
  deleteModelDialogMsg: (model) => `${model}\nPreview only — real host settings are untouched.`,
  confirmDeleteBtn: "Remove",
  sheetTitle: "Prototype Actions",
  sheetMessage: "Choose an action for the current UI Kit specimen.",
  sheetDuplicate: "Duplicate Specimen",
  sheetExport: "Export Tokens JSON",
  sheetDelete: "Delete Draft",
};

export function resolveStyleLabCopy(locale?: string): StyleLabCopy {
  return (locale ?? "").toLowerCase().startsWith("zh") ? zhCopy : enCopy;
}

export function colorSwatches(c: ColorTokens): ReadonlyArray<{ name: string; value: string; textLight?: boolean }> {
  return [
    { name: "Canvas", value: c.canvas },
    { name: "Surface", value: c.surface },
    { name: "Recessed", value: c.recessed },
    { name: "Primary Button", value: c.primaryButton, textLight: true },
    { name: "Accent", value: c.accent, textLight: true },
    { name: "Skill", value: c.skill, textLight: true },
    { name: "Success", value: c.success, textLight: true },
    { name: "Warning", value: c.warning, textLight: true },
    { name: "Danger", value: c.danger, textLight: true },
  ];
}
