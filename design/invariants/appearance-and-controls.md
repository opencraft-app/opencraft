# Workbench invariants: Appearance and controls

[Invariant index](../invariants.md) · [Design index](../README.md)

## Discrete slider fill

The shared track owns capsule clipping. Its selected range has a square inner
edge beneath the circular thumb, so the accent fills the entire track to the
thumb without a rounded notch. The range end must coincide with the **actual
thumb center**, including Radix's radius-based in-bounds offset at each stop.
A raw percentage aligns only at the midpoint: use the selected fraction and the
shared thumb-size token to correct the logical end margin, so density changes
and RTL retain the same geometry without another DOM measurement owner.
Radix retains value, pointer and keyboard ownership.

Visual regression checks measure fill end versus rendered thumb center at every
stop and during held preview, with a subpixel tolerance. A CSS-property assertion
or screenshots of one favorable stop cannot establish this invariant. Preserve
a failing pre-fix case; inspect near-start, middle and near-end output in addition
to theme/density/DPR coverage. `scripts/smoke/conversation/smoke-reasoning-slider.ts` verifies the real
Composer consumer and keeps per-stop screenshots and geometric samples.


## UI 图标：共享视觉语言

- 图形由显式呈现策略选择：OpenCraft core 使用语义图形和共享图标 primitive；下游产品适配保留既有组件的形状、描边、尺度、leading-slot 与选中/hover；颜色主题不选择图形或授予能力。每个 Shadow DOM/presentation root 独立投影 token，多实例不写 document 产品状态。
- core Web/Electron 导航使用共享图标度量：共享自绘图形的 24 单位画布、14px、1.8 描边、圆端点和圆连接；普通控件使用其共享 primitive 的显式尺度与描边；下游产品按各自 consumer 保留配置的 classic 图形、16 单位填充图形和显式描边；品牌标识、内容插图与上游生成资源独立，不由通用 SVG 选择器改写。
- `apps/workbench-web/src/components/ui/workbench-icon.tsx` 是导航、设置与面板扩展语义名到图形的唯一 Web 映射。扩展传递语义名；core 未知名称显示中性帮助图形；下游产品的导航/设置/面板保留旧 consumer 的 Blocks/Plus fallback，不误呈现为某个已知功能。
- `workbenchIconMetrics` 与 `icons.web.scss` 拥有尺度/描边 primitive，core 导航14px、1.8描边，普通/选中均为轮廓，选中含义由行背景和文字保持；下游产品按旧 consumer 的15/16/14px与原 SVG 属性投影，不强改其他旧组件的显式描边。导航前导槽位沿用 `--size-navigation-leading-slot`，直接 SVG 与包装槽位保持光学中心和文字起点对齐；unified Shell 对 core 上方目的地与下方 Settings 共享 Shell inline inset，不让窄屏通用 Settings padding 改变其中一列。紧凑工具按钮保留其宿主尺寸；不能将所有场景强制放大。
- 同一操作在展开/收起入口使用相同图形；状态变化不改变按钮命中区、焦点或布局。图标继承控件颜色，不另设选中配色。
- 独立 core 桌面 rail 的应用导航为 20px，footer 保持 16px；这些例外只作用于各自 rail 区域；应用图标统一消费 Shell 的尺寸，包含显式产品图形家族，不能在共同侧栏列覆盖 `--size-icon-navigation`，否则相邻 Settings 与商业产品会被一同放大。core Settings 仍为 14px 导航角色；下游产品导航/Settings 保留原 consumer 的 15/16px。产品隔离浏览器选中真实 Settings，比对固定旧 Settings 图形并独立校验 Palette/SunMoon 家族；Home/New chat 不再冒充旧 Write。浅深与 DPR1/2 分别核对，不以更新截图或复制当前 resolver 代替兼容预期。
- 验证：`npx tsx scripts/smoke/shell/smoke-icons.ts` 使用真实导航组件检查浅/深色、DPR 1/2、选中与折叠按钮几何，生成图谱和结果 JSON。下游产品目录的 `npm run smoke:sidebar-icons` 另挂载真实 unified AppShell，检查宽窄侧栏双列几何、普通/选中及 下游源样式/图形对照；三面 release 用 `smoke-product-isolation.mjs` 检查根隔离。Web 构建与组件证据不代表 Electron 原生窗口验收。


## UI font preference (2026-10-15)

Web/Electron UI and prose consume the shared typography registry with bundled Inter Variable / Inter first, followed by the existing system and CJK fallback order. Native continues to use its system face. The initial family-preference change retained metric values; subsequent semantic metrics and usage are governed by [UI-TYPE-1](../ui/typography.md). Monospace family preferences and platform smoothing remain independent. Font loading and theme changes must not introduce clipped navigation or horizontal overflow.

## UI-TYPE-1 — Semantic typography ownership

Implemented: the existing registry owns semantic metrics; owned Web, Native and
plugin consumers project those roles, independent of tone/state/geometry. Current
configuration values (model, effort, permission) share the regular compact role;
explanatory copy never consumes a button role. Exact specialist exceptions are
reviewed, not a debt baseline. Contract and Agent routing: [typography](../ui/typography.md).
Evidence: `check:typography`, `test:typography`, `smoke:typography`. Mac/Windows font
rasterization and Native hardware remain separately reported platform acceptance.

## Touch Newera conversation header

Floating header controls consume the lighter variant of shared mobile-glass,
with an internal optical rim/highlight and translucent fill; no outer shadow is permitted.
Search/navigation keep their denser variant; opaque accessibility fallbacks and
the existing hit areas, fade and control owners are unchanged.

Draft and conversation routes share this presentation. With touch density and Newera enabled, Shell presents the existing left/right sidebar and conversation-menu controls as floating glass circles, using the shared mobile-glass material and its opaque accessibility fallback. Visible title/pencil are suppressed; the capability-gated preview toggle keeps its existing position and command, and Rename retains the existing menu/writer/modal. Other routes, compact density and Newera-off retain their normal chrome. This scoped presentation replaces the neutral-button/titlebar appearance, not control ownership.
Shell keeps its existing header measurements, safe-area clearance, 44px touch targets, stationary wide-touch sidebar portal, main-content lifetime and scroll geometry. Its existing pointer-transparent top-fade softly blends content toward the theme surface, without an opaque title strip or a new scroll observer. Preference or route changes do not remount the editor.

### Contribution icon authority

Registered navigation and settings icon names remain effective in every
presentation style. Classic artwork variants, sizes and selected-state strokes
may differ; generic fallbacks apply only to missing or unsupported names.

## Appearance runtime ownership

Process summary headers and subagent status retain the shared body role. Their
mobile text-size adjustment is 100%, including running shimmer descendants, so
long commands cannot receive a separate automatic inflation factor. This does
not change the reading preference or introduce a separate process font scale.

The application appearance owner publishes one immutable snapshot for preference,
resolved system mode, retained requested ID, applied fallback and catalog. Settings
and React consumers subscribe to that owner; palette changes do not remount drafts.
Only the active contribution source may update the catalog; disconnect retains the
requested extension ID and falls back to an available built-in, restoring the
selection when its contribution returns. The presentation policy's built-in default
(or first visible built-in) owns fallback; unrelated missing IDs do not switch to a
newly loaded extension default. An all-hidden policy retains Neutral for safety.
The visible product default leads the theme choices; other built-ins retain their
order, followed by extensions in registration order. Saved selection does not reorder choices.

Shared compiler/palettes are unchanged dependency ports. Theme projection owns its
CSS properties, mode/classes and native appearance payload; document initialization
also owns product presentation and theme-color metadata. Explicit element projection
preserves unrelated styles and does not claim document/product ownership. Legacy
preference keys and IDs remain compatibility data.


## OpenCraft built-in theme identity
Built-in theme IDs use `opencraft.core.*` (neutral, canvas, frost, lavender, mist, graphite). Appearance selection and mode write only `opencraft.appearance-theme-id` and `opencraft.appearance-theme`. Former built-in IDs, including both previous Graphite IDs, are exact read aliases, including trusted build policy; extension IDs remain opaque. Canonical saved keys take precedence over legacy fallback keys. Existing saved values are not deleted, and policy hiding/default conflicts are checked after alias normalization. Bootstrap mode uses the same key priority to avoid an initial appearance mismatch. Palette, geometry and rendering contracts are unchanged.

## Input-dependent hover across Web surfaces

Transient hover requires both fine hover capability and the shared document
input signal through `controls.hover-capable`. Touch and pen contact suppress
residual hover across reflow and portals; real mouse movement restores it.
Keyboard focus and persistent open/selected states remain outside that gate.
Composer suggestions and hover previews only react to mouse entry. Essential
content/card actions stay directly reachable with `controls.touch-input`,
including after touch on hybrid hardware, independently of UI density.
Separate HTML documents own their binding; embedded media pointer tracking is
not a hover disclosure and retains its existing input owner.

### Hover policy enforcement (2026-10-23)

Hover selectors require the shared input/capability guard on every alternative.
Focus, open and selected alternatives remain outside that guard. Hover entry
handlers admit mouse input before effects; pointer drag movement requires its
existing matching owner. Token usage heatmap preview follows mouse or keyboard,
while explicit tap/keyboard selection is persistent and accessible through
native buttons and aria-pressed. The daily table remains available.


## Window appearance projection

The existing appearance owner resolves one `WindowAppearanceIntent`: source and
resolved mode, native window material/background, and Shell edge background.
The edge uses the theme surface; native window background may use
`surfaces.window`. These are different semantic roles, especially for Longing.
Theme providers contribute palettes rather than status-bar controls or offsets.

`WindowPresentation` separates host (browser, Electron, native container, embedded)
from display mode (tab, standalone, fullscreen). The browser paints the document
edge and sends `theme-color` as a hint; Electron uses its existing validated bridge
and retains window transparency. Embedded/native-container documents paint their
own edges but have no new system-appearance API. Host-owned means system bars, not
ownership of another document. Native-container recognition validates the existing
identity contract. WindowChrome remains the owner of titlebar controls/reservations;
it does not turn its desktop left/right reservation into physical safe-area insets.

The HTML head uses generated palette data from the same catalog and product policy
as runtime. It shares mode resolution and preference-key priority, normalizes old
builtin aliases, never writes preferences, and marks unknown/hidden selections as
fallback. Runtime projection takes over when themes load, including late plugin
contributions. No persistent palette cache or parallel theme catalog is introduced.
The legacy Apple status-bar-style declaration remains the stable
`black-translucent` overlay request described below; it is not rewritten on theme
changes and does not prove native drawing capability. A separate early head
script projects the generated catalog before application/diagnostic startup.
Browser html/body paint the same opaque edge background before density or runtime
initialization; live projection updates `theme-color` and `color-scheme` together
with that background. Explicit modes override system changes; system preference
continues to use the original media subscription. No new theme/cache owner is
introduced.

Projection reports requested colors, chosen host strategy and bootstrap/fallback/
resolved phase. `systemAppearance: unobserved` is deliberate: DOM/meta/bridge writes
cannot verify native status-bar pixels. Safe-area and keyboard geometry remain with
the existing viewport owner; no negative-position status strip or duplicate inset.
On current iOS, installed metadata and WebKit top-color sampling can affect native
results. Device acceptance covers cold start, theme/system changes, SPA conversation
navigation, foreground return and rotation, for both existing and fresh installs.


The page's active ClientRuntime implements the narrow window-appearance projector;
the appearance owner binds/unbinds this port without transferring theme state.
WebRuntime/PwaRuntime/ElectronRuntime share the existing intent codec. Native
fullscreen/input subscriptions retire with the runtime, while bootstrap head
projection remains pure and native system pixels remain unobserved. See
[ClientRuntime](../../docs/architecture/platform/client-runtime.md).


### Standalone WebKit edge-color compatibility

The document declares the legacy iOS `black-translucent` status-bar request and
`viewport-fit=cover`. The presentation projector records
`legacy-overlay-requested` only for a standalone/fullscreen browser document;
this names an intent, not native acceptance or a measured full-screen viewport.
Shell and drawer backgrounds keep their full painted boxes. SafeLayout consumes
the top inset inside those boxes so controls stay clear of system content.
The existing viewport owner retains keyboard geometry. No screen-height subtraction
or guessed inset is introduced when the platform returns zero.

Overlay requests and system-color sampling are exclusive document strategies.
The sampling surface below is enabled only for `system-color-extension` (when the
overlay request is absent). Host-owned native chrome does not select either web
strategy. Bootstrap and live projection read the same declaration and report the
same strategy; existing bounded viewport diagnostics separately report the request,
sampling visibility and actual screen/layout/safe-content geometry. Those observations
do not assert that the system painted the requested area.

A single empty, aria-hidden document surface lives outside the application root,
route lifetimes and transformed panels. The HTML head's existing presentation
projection admits only the system-color-extension browser strategy in
standalone/fullscreen display mode; CSS
capability checks exclude engines without WebKit touch-callout/text clipping.
Ordinary tabs, Electron, embedded and native-container hosts keep it disabled.
This is a rendering compatibility hint, not an iOS version detector or promised
system capability. It consumes the existing semantic Shell edge background from
bootstrap through runtime/plugin theme changes, without a second color writer.

The fixed surface exceeds the host's thin-border sampling threshold, carries a
background style and clips it to empty text. It paints no strip over the page and
receives no pointer/focus input. It does not reserve an inset, create a safe-area
value, move controls, animate or write viewport/status-bar metadata. SafeLayout,
keyboard geometry and native system rendering retain their respective owners.

The existing window-appearance smoke verifies both declared policies at actual
document startup and exclusion
on Chromium and desktop WebKit. Its explicit iOS CSS predicate projection exercises
the enabled WebKit styles, theme inheritance, hit testing and unchanged page pixels.
Complete-application checks separately cover navigation and draft continuity.
Native status-bar color/blur and physical full-bleed remain unobserved until
separately verified on the installed target device; a smaller layout viewport is
not repaired or hidden by this surface.
