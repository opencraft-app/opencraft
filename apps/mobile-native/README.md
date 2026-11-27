# OpenCraft Mobile Native Shell (Valdi + WebView)

超薄纯原生移动宿主（零 Expo、零 React Native、零 Metro）：

- **Web Workbench 画布**：系统 `WKWebView` 承载随包构建的完整 `@opencraft/workbench-web`，通过 `WKScriptMessageHandlerWithReply` 从 Bundle 内存映射直读模块资源，保持 `https://opencraft.invalid/` 安全上下文（`isSecureContext`、`crypto.subtle`、`IndexedDB`）以及自托管 HTTPS 站点的 `WKWebsiteDataStore.nonPersistent()` 物理隔离。
- **Valdi 120Hz 原生交互层**：集成 `@opencraft/design-system-valdi`（`packages/design-system-valdi`），承载浮动 `<glass>` 源控制按钮、原生 Liquid Glass 工作区来源设置面板，以及由 Web 委托触发的 `ConfirmDialog` / `ActionSheet` 与系统级触感反馈（Haptics）。

## 构建步骤（iOS）

1. **同步设计令牌（当修改了 `@opencraft/design-system` 时）**
   ```bash
   npx tsx packages/design-system-valdi/scripts/sync-tokens.mjs
   ```

2. **编译 `OpenCraftValdi.xcframework`（首次或修改了 `packages/design-system-valdi` 时）**
   ```bash
   export VALDI_WORKSPACE=/path/to/Snapchat-Valdi-checkout
   export VALDI_BAZEL=/path/to/bazel-8.2.1
   node apps/mobile-native/scripts/build-valdi-ios.mjs
   ```

3. **构建随包 WebBundle**
   ```bash
   npx tsx apps/mobile-native/scripts/build-web-bundle.mts
   ```

4. **编译并安装到 iOS 模拟器**
   ```bash
   xcodebuild -project apps/mobile-native/ios/OpenCraftMobile.xcodeproj \
     -scheme OpenCraftMobile \
     -configuration Debug \
     -sdk iphonesimulator \
     -derivedDataPath apps/mobile-native/ios/DerivedData \
     build
   ```
