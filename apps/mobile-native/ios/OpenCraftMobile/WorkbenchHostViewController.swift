import UIKit
import WebKit

private let kMobileContainerVersion = 1
private let kMobileContainerOrigin = "https://opencraft.invalid"

private final class WeakScriptMessageProxy: NSObject, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    weak var target: WorkbenchHostViewController?
    init(target: WorkbenchHostViewController) {
        self.target = target
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.handleScriptMessage(message)
    }
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        target?.handleAssetReplyMessage(message, replyHandler: replyHandler)
    }
}

final class WorkbenchHostViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let copy = NativeMobileCopy.loadFromBundle()
    private let assetQueue = DispatchQueue(label: "app.opencraft.mobile.asset-reader", qos: .userInitiated, attributes: .concurrent)
    private let valdiOverlay = ValdiOverlayView(frame: .zero)
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let errorContainer = UIStackView()
    private let errorLabel = UILabel()
    private let retryButton = UIButton(type: .system)

    private var webView: WKWebView?
    private var source: MobileContentSource = .bundled
    private var runtimeId: String = UUID().uuidString.lowercased()
    private var webReady = false
    private var welcomeOwnedByNative = false
    private var welcomeThemePref = "system"
    private var canGoBack = false
    private var isDark = false
    private var edgeColor: UIColor?
    private var lastCrashAutoReloadAt: Date?

    private enum ActiveOverlay {
        case none
        case sourceSettings(pending: Bool, error: String?)
        case confirmDialog(requestId: String, title: String, message: String?, confirmLabel: String, cancelLabel: String, destructive: Bool)
        case actionSheet(requestId: String, title: String?, message: String?, cancelLabel: String, actions: [[String: Any]])
    }
    private var activeOverlay: ActiveOverlay = .none

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return isDark ? .lightContent : .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        isDark = traitCollection.userInterfaceStyle == .dark
        updateContainerBackground()
        setupErrorAndLoadingViews()
        setupValdiOverlay()
        setupLifecycleObservers()

        do {
            source = try SourceStore.read()
            mountWorkspaceSurface()
        } catch {
            NSLog("[OpenCraftNative] Source read failed: %@", String(describing: error))
            showSurfaceFailure()
        }
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if edgeColor == nil {
            let systemDark = traitCollection.userInterfaceStyle == .dark
            if systemDark != isDark {
                isDark = systemDark
                setNeedsStatusBarAppearanceUpdate()
                updateContainerBackground()
                syncValdiOverlay()
            }
        }
    }

    private func setupLifecycleObservers() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
    }

    @objc private func appDidBecomeActive() {
        sendContainerEvent(["type": "visibility", "active": true])
    }

    @objc private func appWillResignActive() {
        sendContainerEvent(["type": "visibility", "active": false])
    }

    private func setupErrorAndLoadingViews() {
        loadingSpinner.translatesAutoresizingMaskIntoConstraints = false
        loadingSpinner.hidesWhenStopped = true
        view.addSubview(loadingSpinner)

        errorLabel.text = copy.failedLabel
        errorLabel.numberOfLines = 0
        errorLabel.textAlignment = .center
        errorLabel.font = .systemFont(ofSize: 16)

        retryButton.setTitle(copy.retryLabel, for: .normal)
        retryButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        retryButton.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

        errorContainer.axis = .vertical
        errorContainer.spacing = 14
        errorContainer.alignment = .center
        errorContainer.translatesAutoresizingMaskIntoConstraints = false
        errorContainer.isHidden = true
        errorContainer.addArrangedSubview(errorLabel)
        errorContainer.addArrangedSubview(retryButton)
        view.addSubview(errorContainer)

        NSLayoutConstraint.activate([
            loadingSpinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            loadingSpinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            errorContainer.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorContainer.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 28),
            errorContainer.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -28),
        ])
    }

    private func setupValdiOverlay() {
        valdiOverlay.frame = view.bounds
        valdiOverlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        valdiOverlay.onOpenSourceSettings = { [weak self] in
            self?.presentSourceSettings()
        }
        valdiOverlay.onCloseOverlay = { [weak self] in
            self?.dismissActiveOverlay()
        }
        valdiOverlay.onSaveSource = { [weak self] kind, rawUrl in
            self?.handleSaveSource(kind: kind, rawUrl: rawUrl)
        }
        valdiOverlay.onConfirmResult = { [weak self] confirmed in
            self?.resolveConfirmDialog(confirmed: confirmed)
        }
        valdiOverlay.onActionSheetResult = { [weak self] actionId in
            self?.resolveActionSheet(actionId: actionId)
        }
        valdiOverlay.onWelcomeConnect = { [weak self] in
            self?.navigateFromNativeWelcome(section: "mobile-connection")
        }
        valdiOverlay.onWelcomeExplore = { [weak self] in
            self?.navigateFromNativeWelcome(section: "appearance")
        }
        view.addSubview(valdiOverlay)
        syncValdiOverlay()
    }

    private func navigateFromNativeWelcome(section: String) {
        valdiOverlay.triggerHapticStyle("light")
        welcomeOwnedByNative = false
        syncValdiOverlay()
        sendContainerEvent(["type": "navigate-settings", "section": section])
        NSLog("[OpenCraftNative] Native Valdi Welcome navigated to settings/%@", section)
    }

    @objc private func retryTapped() {
        mountWorkspaceSurface()
    }

    private func updateContainerBackground() {
        let fallback = isDark
            ? UIColor(red: 0.11, green: 0.11, blue: 0.12, alpha: 1.0)
            : UIColor.white
        let resolved = edgeColor ?? fallback
        view.backgroundColor = resolved
        errorLabel.textColor = isDark ? .white : UIColor(white: 0.12, alpha: 1.0)
        loadingSpinner.color = isDark ? UIColor(white: 0.75, alpha: 1.0) : UIColor(white: 0.35, alpha: 1.0)
        if let wv = webView {
            wv.backgroundColor = resolved
            if #available(iOS 15.0, *) {
                wv.underPageBackgroundColor = resolved
            }
        }
    }

    // MARK: - WebView Mounting & Isolation

    private func tearDownCurrentWebView() {
        guard let existing = webView else { return }
        existing.configuration.userContentController.removeAllScriptMessageHandlers()
        existing.configuration.userContentController.removeAllUserScripts()
        existing.navigationDelegate = nil
        existing.uiDelegate = nil
        existing.stopLoading()
        existing.removeFromSuperview()
        webView = nil
    }

    private func mountWorkspaceSurface() {
        tearDownCurrentWebView()
        runtimeId = UUID().uuidString.lowercased()
        webReady = false
        canGoBack = false
        errorContainer.isHidden = true
        loadingSpinner.startAnimating()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        switch source {
        case .bundled:
            welcomeOwnedByNative = true
            syncValdiOverlay()
            config.websiteDataStore = .default()
            let proxy = WeakScriptMessageProxy(target: self)
            let ucc = config.userContentController
            ucc.add(proxy, name: "opencraftMobile")
            ucc.addScriptMessageHandler(proxy, contentWorld: .page, name: "opencraftAsset")
            let debugScene = ProcessInfo.processInfo.environment["OPENCRAFT_DEBUG_VERIFY_SCENE"] ?? ""
            let themeInitScript = debugScene.hasPrefix("dark:")
                ? "try { localStorage.setItem('opencraft.appearance-theme', 'dark'); } catch {}"
                : "try { localStorage.removeItem('opencraft.appearance-theme'); } catch {}"
            let bootstrapScript = """
            (() => {
              \(themeInitScript)
              const identity = Object.freeze({
                version: \(kMobileContainerVersion),
                runtimeId: "\(runtimeId)",
                capabilities: Object.freeze({ valdi: true })
              });
              Object.defineProperty(window, "opencraftMobile", { value: identity, configurable: false, writable: false });
              Object.defineProperty(window, "opencraftMobileHost", {
                value: Object.freeze({
                  postMessage(raw) {
                    window.webkit.messageHandlers.opencraftMobile.postMessage(String(raw));
                  }
                }),
                configurable: false,
                writable: false
              });
              Object.defineProperty(window, "__opencraftNativeReadAsset", {
                value: (resourceId) => window.webkit.messageHandlers.opencraftAsset.postMessage({
                  runtimeId: identity.runtimeId,
                  resourceId: String(resourceId)
                }),
                configurable: false,
                writable: false
              });
              const origError = console.error.bind(console);
              console.error = (...args) => {
                origError(...args);
                try {
                  const detail = args.map(a => a instanceof Error ? (a.stack || a.message) : typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
                  window.webkit.messageHandlers.opencraftMobile.postMessage(JSON.stringify({
                    ...identity, type: "debug-js-error", detail: detail.slice(0, 2000)
                  }));
                } catch {}
              };
              window.addEventListener("error", (e) => {
                window.webkit.messageHandlers.opencraftMobile.postMessage(JSON.stringify({
                  ...identity, type: "debug-js-error", detail: String(e.error?.stack || e.message || e)
                }));
              });
              window.addEventListener("unhandledrejection", (e) => {
                window.webkit.messageHandlers.opencraftMobile.postMessage(JSON.stringify({
                  ...identity, type: "debug-js-error", detail: String(e.reason?.stack || e.reason || e)
                }));
              });
            })();
            """
            ucc.addUserScript(WKUserScript(source: bootstrapScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        case .selfHosted:
            // Remote websites get an isolated ephemeral data store and zero native bridge/identity.
            config.websiteDataStore = .nonPersistent()
        }

        let wv = WKWebView(frame: view.bounds, configuration: config)
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.bounces = false
        wv.isOpaque = true
#if DEBUG
        if #available(iOS 16.4, *) {
            wv.isInspectable = true
        }
#endif
        view.insertSubview(wv, belowSubview: loadingSpinner)
        webView = wv
        updateContainerBackground()
        syncValdiOverlay()

        switch source {
        case .bundled:
            guard let htmlUrl = Bundle.main.url(forResource: "mobile-workbench", withExtension: "html", subdirectory: "WebBundle"),
                  let html = try? String(contentsOf: htmlUrl, encoding: .utf8),
                  let originUrl = URL(string: kMobileContainerOrigin + "/") else {
                NSLog("[OpenCraftNative] Missing bundled WebBundle/mobile-workbench.html")
                showSurfaceFailure()
                return
            }
            NSLog("[OpenCraftNative] Loading bundled workspace (runtimeId=%@)", runtimeId)
            wv.loadHTMLString(html, baseURL: originUrl)
        case .selfHosted(let urlString):
            guard let remoteUrl = URL(string: urlString) else {
                showSurfaceFailure()
                return
            }
            NSLog("[OpenCraftNative] Loading self-hosted workspace: %@", urlString)
            wv.load(URLRequest(url: remoteUrl))
        }
    }

    private func showSurfaceFailure() {
        tearDownCurrentWebView()
        webReady = false
        loadingSpinner.stopAnimating()
        errorContainer.isHidden = false
        syncValdiOverlay()
    }

    // MARK: - Native Asset Reader & Container Protocol

    fileprivate func handleAssetReplyMessage(_ message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard source == .bundled,
              message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              let incomingRuntime = body["runtimeId"] as? String,
              incomingRuntime == runtimeId,
              let resourceId = body["resourceId"] as? String,
              resourceId.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            replyHandler(nil, "Packaged resource rejected")
            return
        }
        guard let fileUrl = Bundle.main.url(forResource: resourceId, withExtension: "ocasset", subdirectory: "WebBundle/resources") else {
            replyHandler(nil, "Packaged resource missing")
            return
        }
        let activeRuntime = runtimeId
        assetQueue.async { [weak self] in
            guard let data = try? Data(contentsOf: fileUrl, options: .mappedIfSafe),
                  let text = String(data: data, encoding: .utf8) else {
                DispatchQueue.main.async { replyHandler(nil, "Packaged resource unreadable") }
                return
            }
            DispatchQueue.main.async {
                guard let self, self.runtimeId == activeRuntime else {
                    replyHandler(nil, "Runtime retired")
                    return
                }
                replyHandler(text, nil)
            }
        }
    }

    fileprivate func handleScriptMessage(_ message: WKScriptMessage) {
        guard source == .bundled,
              message.name == "opencraftMobile",
              message.frameInfo.isMainFrame,
              let raw = message.body as? String,
              raw.utf8.count <= 16384,
              let data = raw.data(using: .utf8),
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let version = payload["version"] as? Int, version == kMobileContainerVersion,
              let incomingRuntime = payload["runtimeId"] as? String, incomingRuntime == runtimeId,
              let type = payload["type"] as? String else {
            return
        }

        switch type {
        case "ready":
            webReady = true
            loadingSpinner.stopAnimating()
            errorContainer.isHidden = true
            syncValdiOverlay()
            sendContainerEvent(["type": "visibility", "active": UIApplication.shared.applicationState == .active])
            NSLog("[OpenCraftNative] Bundled Workbench ready (runtimeId=%@)", runtimeId)
#if DEBUG
            runDebugVerificationTriggerIfNeeded()
#endif

        case "navigation":
            if let nextBack = payload["canGoBack"] as? Bool {
                canGoBack = nextBack
            }

        case "appearance":
            if let resolved = payload["resolvedTheme"] as? String,
               (resolved == "light" || resolved == "dark"),
               let edge = payload["edgeBackgroundColor"] as? String {
                isDark = (resolved == "dark")
                edgeColor = Self.parseCssColor(edge)
                setNeedsStatusBarAppearanceUpdate()
                updateContainerBackground()
                syncValdiOverlay()
                NSLog("[OpenCraftNative] Appearance synced: theme=%@ edge=%@", resolved, edge)
            }

        case "source-settings":
            presentSourceSettings()

        case "reload":
            mountWorkspaceSurface()

        case "surface-state":
            if let surface = payload["surface"] as? String {
                let nextWelcome = (surface == "welcome")
                if nextWelcome != welcomeOwnedByNative {
                    welcomeOwnedByNative = nextWelcome
                    syncValdiOverlay()
                    NSLog("[OpenCraftNative] Native Valdi Welcome surface-state=%@", surface)
                }
            }

        case "haptic":
            if let style = payload["style"] as? String {
                valdiOverlay.triggerHapticStyle(style)
            }

        case "startup-error":
            NSLog("[OpenCraftNative] Web Workbench reported startup-error")
            showSurfaceFailure()

        case "debug-js-error":
            NSLog("[OpenCraftNative] JS Error: %@", (payload["detail"] as? String) ?? "unknown")

        case "external":
            if let urlString = payload["url"] as? String {
                openValidatedExternalUrl(urlString)
            }

        case "confirm-dialog":
            guard let requestId = payload["requestId"] as? String,
                  let title = payload["title"] as? String, !title.isEmpty,
                  let confirmLabel = payload["confirmLabel"] as? String, !confirmLabel.isEmpty,
                  let cancelLabel = payload["cancelLabel"] as? String, !cancelLabel.isEmpty else {
                return
            }
            let dialogMsg = payload["message"] as? String
            let destructive = (payload["destructive"] as? Bool) ?? false
            valdiOverlay.triggerHapticStyle("light")
            activeOverlay = .confirmDialog(
                requestId: requestId,
                title: title,
                message: dialogMsg,
                confirmLabel: confirmLabel,
                cancelLabel: cancelLabel,
                destructive: destructive
            )
            syncValdiOverlay()
            NSLog("[OpenCraftNative] Presented Valdi ConfirmDialog (requestId=%@)", requestId)

        case "action-sheet":
            guard let requestId = payload["requestId"] as? String,
                  let cancelLabel = payload["cancelLabel"] as? String, !cancelLabel.isEmpty,
                  let rawActions = payload["actions"] as? [[String: Any]], !rawActions.isEmpty else {
                return
            }
            valdiOverlay.triggerHapticStyle("light")
            activeOverlay = .actionSheet(
                requestId: requestId,
                title: payload["title"] as? String,
                message: payload["message"] as? String,
                cancelLabel: cancelLabel,
                actions: rawActions
            )
            syncValdiOverlay()
            NSLog("[OpenCraftNative] Presented Valdi ActionSheet (requestId=%@)", requestId)

        default:
            break
        }
    }

    private func sendContainerEvent(_ fields: [String: Any]) {
        guard source == .bundled, webReady, let wv = webView else { return }
        var detail: [String: Any] = [
            "version": kMobileContainerVersion,
            "runtimeId": runtimeId,
            "capabilities": ["valdi": true],
        ]
        for (k, v) in fields { detail[k] = v }
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        wv.evaluateJavaScript("window.dispatchEvent(new CustomEvent('opencraft-mobile',{detail:\(json)}));true;", completionHandler: nil)
    }

    // MARK: - Valdi Overlay Choreography

    private func presentSourceSettings() {
        valdiOverlay.triggerHapticStyle("light")
        activeOverlay = .sourceSettings(pending: false, error: nil)
        syncValdiOverlay()
        NSLog("[OpenCraftNative] Presented Valdi SourceSettings sheet")
    }

    private func dismissActiveOverlay() {
        switch activeOverlay {
        case .confirmDialog(let requestId, _, _, _, _, _):
            activeOverlay = .none
            syncValdiOverlay()
            sendContainerEvent(["type": "confirm-dialog-result", "requestId": requestId, "confirmed": false])
        case .actionSheet(let requestId, _, _, _, _):
            activeOverlay = .none
            syncValdiOverlay()
            sendContainerEvent(["type": "action-sheet-result", "requestId": requestId, "actionId": NSNull()])
        case .sourceSettings:
            activeOverlay = .none
            syncValdiOverlay()
        case .none:
            break
        }
    }

    private func handleSaveSource(kind: String, rawUrl: String) {
        let nextSource: MobileContentSource
        if kind == "self-hosted" {
            do {
                nextSource = try SourceStore.validateSelfHostedUrl(rawUrl)
            } catch {
                activeOverlay = .sourceSettings(pending: false, error: copy.invalidUrlError)
                syncValdiOverlay()
                return
            }
        } else {
            nextSource = .bundled
        }

        activeOverlay = .sourceSettings(pending: true, error: nil)
        syncValdiOverlay()

        do {
            try SourceStore.write(nextSource)
        } catch {
            activeOverlay = .sourceSettings(pending: false, error: copy.saveFailedError)
            syncValdiOverlay()
            return
        }

        let unchanged = (nextSource == source)
        activeOverlay = .none
        if unchanged {
            syncValdiOverlay()
            return
        }
        source = nextSource
        edgeColor = nil
        mountWorkspaceSurface()
    }

    private func resolveConfirmDialog(confirmed: Bool) {
        guard case .confirmDialog(let requestId, _, _, _, _, _) = activeOverlay else { return }
        activeOverlay = .none
        syncValdiOverlay()
        sendContainerEvent(["type": "confirm-dialog-result", "requestId": requestId, "confirmed": confirmed])
        NSLog("[OpenCraftNative] Resolved Valdi ConfirmDialog (requestId=%@, confirmed=%d)", requestId, confirmed ? 1 : 0)
    }

    private func resolveActionSheet(actionId: String?) {
        guard case .actionSheet(let requestId, _, _, _, _) = activeOverlay else { return }
        activeOverlay = .none
        syncValdiOverlay()
        sendContainerEvent([
            "type": "action-sheet-result",
            "requestId": requestId,
            "actionId": actionId as Any? ?? NSNull(),
        ])
        NSLog("[OpenCraftNative] Resolved Valdi ActionSheet (requestId=%@, actionId=%@)", requestId, actionId ?? "cancel")
    }

    private func syncValdiOverlay() {
        let floatingVisible = !webReady || source != .bundled
        let showNativeWelcome = source == .bundled && welcomeOwnedByNative
        let isZh = Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") ?? false
        var state: [String: Any] = [
            "dark": isDark,
            "showFloatingControl": floatingVisible,
            "welcomeVisible": showNativeWelcome,
            "welcomeBrandLabel": "OpenCraft",
            "welcomeTitle": isZh ? "欢迎使用 OpenCraft" : "Welcome to OpenCraft",
            "welcomeSubtitle": isZh ? "连接你的 OpenCraft 服务器，开始对话或运行智能体。" : "Use your OpenCraft server to chat and run agents.",
            "welcomeQuickGroup": isZh ? "开始使用" : "Get Started",
            "welcomeConnectTitle": isZh ? "连接服务器" : "Connect a server",
            "welcomeConnectDetail": "HTTPS",
            "welcomeExploreTitle": isZh ? "先体验，无需服务器" : "Explore without a server",
            "welcomeExploreDetail": isZh ? "外观" : "Appearance",
            "sourceKind": source.kind,
            "sourceUrl": source.urlString,
            "sourceLabel": copy.sourceLabel,
            "sourceDescription": copy.sourceDescription,
            "bundledLabel": copy.bundledLabel,
            "selfHostedLabel": copy.selfHostedLabel,
            "urlLabel": copy.urlLabel,
            "urlPlaceholder": copy.urlPlaceholder,
            "clearLabel": copy.clearLabel,
            "privacyHint": copy.privacyHint,
            "applyLabel": copy.applyLabel,
            "cancelLabel": copy.cancelLabel,
        ]

        var interactiveModal = showNativeWelcome
        switch activeOverlay {
        case .none:
            state["mode"] = showNativeWelcome ? "welcome" : "idle"
        case .sourceSettings(let pending, let error):
            interactiveModal = true
            state["mode"] = "source-settings"
            state["pending"] = pending
            if let error { state["sourceError"] = error }
        case .confirmDialog(_, let title, let message, let confirmLabel, let cancelLabel, let destructive):
            interactiveModal = true
            state["mode"] = "confirm-dialog"
            state["dialogTitle"] = title
            if let message { state["dialogMessage"] = message }
            state["dialogConfirmLabel"] = confirmLabel
            state["dialogCancelLabel"] = cancelLabel
            state["dialogDestructive"] = destructive
        case .actionSheet(_, let title, let message, let cancelLabel, let actions):
            interactiveModal = true
            state["mode"] = "action-sheet"
            if let title { state["sheetTitle"] = title }
            if let message { state["sheetMessage"] = message }
            state["sheetCancelLabel"] = cancelLabel
            state["sheetActions"] = actions
        }

        valdiOverlay.applyState(state, interactiveModal: interactiveModal, floatingControlVisible: floatingVisible)
    }

    // MARK: - WKNavigationDelegate & Process Recovery

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard webView === self.webView, let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let urlString = url.absoluteString
        let isTopFrame = navigationAction.targetFrame?.isMainFrame ?? false

        switch source {
        case .selfHosted:
            if SourceStore.isAllowedSelfHostedNavigation(source: source, targetUrl: urlString) {
                decisionHandler(.allow)
                return
            }
            if isTopFrame {
                openValidatedExternalUrl(urlString)
            }
            decisionHandler(.cancel)

        case .bundled:
            if !isTopFrame {
                if urlString == "about:blank" || urlString == "about:srcdoc" || urlString.hasPrefix("blob:") || urlString.hasPrefix("data:") {
                    decisionHandler(.allow)
                } else {
                    decisionHandler(.cancel)
                }
                return
            }
            if !webReady && (
                urlString == "about:blank"
                || urlString.hasPrefix("applewebdata:")
                || (url.scheme?.lowercased() == "https" && url.host?.lowercased() == "opencraft.invalid")
            ) {
                decisionHandler(.allow)
                return
            }
            NSLog("[OpenCraftNative] Blocked or redirected bundled navigation: %@", urlString)
            openValidatedExternalUrl(urlString)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        if case .selfHosted = source {
            loadingSpinner.stopAnimating()
            canGoBack = webView.canGoBack
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        NSLog("[OpenCraftNative] Provisional navigation failed: %@", error.localizedDescription)
        showSurfaceFailure()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        let now = Date()
        if let prev = lastCrashAutoReloadAt, now.timeIntervalSince(prev) < 4.0 {
            NSLog("[OpenCraftNative] WebContent terminated repeatedly; entering manual recovery")
            showSurfaceFailure()
            return
        }
        lastCrashAutoReloadAt = now
        NSLog("[OpenCraftNative] WebContent terminated; silently recovering workspace surface")
        mountWorkspaceSurface()
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let urlString = navigationAction.request.url?.absoluteString {
            openValidatedExternalUrl(urlString)
        }
        return nil
    }

    private func openValidatedExternalUrl(_ raw: String) {
        guard raw.utf8.count <= 8192,
              let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              ["https", "http", "mailto", "tel"].contains(scheme),
              components.user == nil,
              components.password == nil,
              let url = components.url else {
            return
        }
        if let host = components.host?.lowercased(), scheme == "https" && host == "opencraft.invalid" {
            return
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    // MARK: - CSS Color Helper & Debug Verification

    private static func parseCssColor(_ raw: String) -> UIColor? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") {
            let hex = String(s.dropFirst())
            var value: UInt64 = 0
            guard Scanner(string: hex).scanHexInt64(&value) else { return nil }
            switch hex.count {
            case 6:
                return UIColor(
                    red: CGFloat((value >> 16) & 0xFF) / 255.0,
                    green: CGFloat((value >> 8) & 0xFF) / 255.0,
                    blue: CGFloat(value & 0xFF) / 255.0,
                    alpha: 1.0
                )
            case 8:
                return UIColor(
                    red: CGFloat((value >> 24) & 0xFF) / 255.0,
                    green: CGFloat((value >> 16) & 0xFF) / 255.0,
                    blue: CGFloat((value >> 8) & 0xFF) / 255.0,
                    alpha: CGFloat(value & 0xFF) / 255.0
                )
            default:
                return nil
            }
        }
        return nil
    }

#if DEBUG
    private func runDebugVerificationTriggerIfNeeded() {
        let rawMode = ProcessInfo.processInfo.environment["OPENCRAFT_DEBUG_VERIFY_SCENE"] ?? ""
        let mode = rawMode.hasPrefix("dark:") ? String(rawMode.dropFirst(5)) : rawMode
        guard !mode.isEmpty, let wv = webView else { return }
        // Probe IndexedDB + WebCrypto secure context inside the packaged origin
        let probeJs = """
        (async () => {
          const secure = window.isSecureContext === true && typeof crypto.subtle === 'object';
          const dbOk = await new Promise((resolve) => {
            const req = indexedDB.open('opencraft_native_mvp_probe', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('kv');
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction('kv', 'readwrite');
              tx.objectStore('kv').put('verified', 'status');
              tx.oncomplete = () => { db.close(); resolve(true); };
              tx.onerror = () => resolve(false);
            };
            req.onerror = () => resolve(false);
          });
          return JSON.stringify({ origin: window.origin, secure, dbOk, valdi: window.opencraftMobile?.capabilities?.valdi === true });
        })();
        """
        wv.callAsyncJavaScript("return await " + probeJs, arguments: [:], in: nil, in: .page) { result in
            if case .success(let value) = result {
                NSLog("[OpenCraftNative] Runtime capabilities verified: %@", String(describing: value))
            }
        }
        if mode == "source-sheet" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.presentSourceSettings()
            }
        } else if mode == "confirm-dialog" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                guard let self, let wv = self.webView else { return }
                wv.evaluateJavaScript("""
                window.opencraftMobileHost.postMessage(JSON.stringify({
                  ...window.opencraftMobile,
                  type: 'confirm-dialog',
                  requestId: '1',
                  title: 'Switch Workspace Source?',
                  message: 'Your unsent draft remains safely stored in local IndexedDB.',
                  confirmLabel: 'Switch',
                  cancelLabel: 'Cancel',
                  destructive: false
                }));true;
                """, completionHandler: nil)
            }
        } else if mode == "action-sheet" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                guard let self, let wv = self.webView else { return }
                wv.evaluateJavaScript("""
                window.opencraftMobileHost.postMessage(JSON.stringify({
                  ...window.opencraftMobile,
                  type: 'action-sheet',
                  requestId: '2',
                  title: 'Workspace Actions',
                  message: 'Rendered natively at 120Hz via Valdi + Liquid Glass',
                  cancelLabel: 'Cancel',
                  actions: [
                    { id: 'reload', label: 'Reload Built-in Workspace' },
                    { id: 'source', label: 'Configure Self-Hosted URL' },
                    { id: 'reset', label: 'Reset Session Cache', destructive: true }
                  ]
                }));true;
                """, completionHandler: nil)
            }
        }
    }
#endif
}
