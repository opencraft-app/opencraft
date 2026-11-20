import "./browser-panel.scss";
import { cancelFrame, frame } from "motion/react";
import { IconButton } from "@opencraft/design-system-web/button";
import { LoadingRingIcon as LoaderCircle, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import type {
  BrowserPageId,
  BrowserTabId,
} from "@opencraft/browser-core";
import {
  browserUrlDisplayValue,
} from "@opencraft/browser-core";
import { BrowserResourcesButton } from './browser-resources-button';
import { BrowserControlButton } from './browser-control-button';
import { BrowserKeyboardButton } from './browser-keyboard-button';
import { BrowserDeviceToolbar, BrowserDeviceHandles } from "./browser-device-toolbar";
import { useIntl } from "@opencraft/i18n/react";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import { usePanelPresentation } from "../components/panel-presentation";
import { ArrowLeftIcon as ArrowLeft, ArrowRightIcon as ArrowRight, ExternalLinkIcon as ExternalLink, GlobeIcon as Globe2, DevicesIcon as MonitorSmartphone, RedoIcon as RotateCw } from "@opencraft/design-system-web/action-icons";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  useSyncExternalStore,
} from "react";
import { BrowserAnnotationLayer } from "../browser-annotation/annotation-layer-lazy";
import { BrowserAnnotationToggle } from "../browser-annotation/annotation-toggle";
import { useBrowserAnnotation } from "../browser-annotation/use-browser-annotation";

import { useAppShellLayoutMotion } from "../components/app-shell";
import { FloatingComposerToggle } from "../components/thread-composer-presentation";
import {
  useBrowserPresentationCoordinator,
  useBrowserTab,
  useOptionalBrowserRuntime,
  useBrowserWorkbench,
  useWebBrowserPage,
  useWebBrowserPageRuntime,
} from "./browser-runtime-context";
import type { BrowserPresentationHandle } from "./browser-presentation-coordinator";
import type { WebBrowserPageRuntime } from "./web-browser-runtime";
import { useWorkbenchPresentationRoot } from "../components/workbench-presentation-root";
import { useShellPresentation } from '../components/shell-presentation';
import { useTouchBrowserLayout } from '../components/use-touch-browser-layout';
const BrowserMobileToolbar = lazy(() => import('./browser-mobile-toolbar'));

const FIT_VIEWPORT = { type: "fit", width: 1440, height: 900 } as const;

function browserTabIdFromPanel(tab: PanelRendererProps["tab"]): BrowserTabId {
  if (tab.resource === undefined) throw new Error(`Browser panel ${tab.id} has no tab resource`);
  return tab.resource as BrowserTabId;
}

export default function BrowserPanel({ tab: panelTab, presentationId, onPresentationReady }: PanelRendererProps) {
  const intl = useIntl();
  const newera = useTouchBrowserLayout();
  const shell = useShellPresentation();
  const mobile = newera && !!shell?.rightPanelFullWidth && panelTab.region === 'right';
  const portalContainer = useWorkbenchPresentationRoot();
  const tabId = browserTabIdFromPanel(panelTab);
  const pages = useWebBrowserPageRuntime();
  const workbench = useBrowserWorkbench();
  const presentations = useBrowserPresentationCoordinator();
  const { rightPanelLayoutTick } = useAppShellLayoutMotion();
  const { active: rightPanelPresentationActive } = usePanelPresentation();
  const tab = useBrowserTab(tabId);
  const pageId = tab?.pageId ?? ("missing-browser-page" as BrowserPageId);
  const page = useWebBrowserPage(pageId);
  const browserRuntime = useOptionalBrowserRuntime();
  const slotRef = useRef<HTMLDivElement | null>(null);
  const presentationRef = useRef<BrowserPresentationHandle | null>(null);
  const [presentationState, setPresentationState] = useState<"loading" | "ready" | "failed">("loading");
  const [presentationAttempt, setPresentationAttempt] = useState(0);
  const [zoom,setZoom]=useState(100);
  useEffect(()=>{setZoom(pages.getZoom(pageId));},[pageId,pages]);
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const surfaces = browserRuntime?.surfaces;
  const agentControlled = useSyncExternalStore(
    (listener) => surfaces?.onControlState?.(listener) ?? (() => {}),
    () => surfaces?.controlState?.(pageId) === "agent",
    () => false,
  );
  const annotator = useMemo(() => pages.annotator(pageId), [pages, pageId, page !== null]);
  const annotation = useBrowserAnnotation({ annotator, pageId, tabId, url: page?.navigation.currentUrl ?? null, blocked: agentControlled });

  useEffect(() => {
    if (page !== null && !editingAddress) setAddress(browserUrlDisplayValue(page.navigation.currentUrl));
  }, [page?.navigation.currentUrl, editingAddress]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot === null || tab === null || page === null || !rightPanelPresentationActive) return;
    setPresentationState("loading");
    let presentation: BrowserPresentationHandle;
    try { presentation = presentations.present({
      pageId: tab.pageId,
      tabId: tab.id,
      viewId: presentationId,
      surface: panelTab.region === "bottom" ? "bottom-panel" : "right-panel",
      slot,
      viewportMode: tab.viewportMode,
    }); } catch {
      setPresentationState("failed");
      return;
    }
    presentationRef.current = presentation;
    // First-frame status belongs to this view, never to the navigation gate.
    let current = true;
    const timeout = setTimeout(() => { if (current) setPresentationState("failed"); }, 15000);
    void presentation.ready.then(() => {
      if (current) { clearTimeout(timeout); setPresentationState("ready"); }
    }, () => {
      if (current) { clearTimeout(timeout); setPresentationState("failed"); }
    });
    // Read after Motion commits ancestor transforms and pane dimensions.
    // A separate browser RAF can run before Motion's final DOM write.
    const measure = () => presentation.measure();
    const scheduleMeasure = () => { frame.postRender(measure); };
    const unsubscribeLayout = rightPanelLayoutTick.on("change", scheduleMeasure);
    scheduleMeasure();
    return () => {
      current = false;
      clearTimeout(timeout);
      cancelFrame(measure);
      unsubscribeLayout();
      if (presentationRef.current === presentation) presentationRef.current = null;
      presentation.dispose();
    };
  }, [
    presentationId,
    presentationAttempt,
    page === null,
    pageId,
    presentations,
    rightPanelLayoutTick,
    rightPanelPresentationActive,
    tabId,
    panelTab.region,
  ]);

  useLayoutEffect(() => {
    if (tab !== null) presentationRef.current?.updateViewportMode(tab.viewportMode);
  }, [tab?.viewportMode]);

  useEffect(() => {
    // The mounted panel already exposes address, loading/error and retry.
    // A missing media frame cannot hold Shell selection or its animation.
    onPresentationReady?.();
  }, [onPresentationReady]);

  if (tab === null || page === null) {
    return (
      <div className="right-panel-empty">
        <span><Globe2 size={18} /></span>
        <strong>{intl.formatMessage({ id: "browser.unavailable", defaultMessage: "Browser tab unavailable" })}</strong>
        <p>{intl.formatMessage({ id: "browser.reopen", defaultMessage: "This tab can be closed and reopened." })}</p>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      if (pages.navigate(page.id, address) === null) setAddress(browserUrlDisplayValue(page.navigation.currentUrl));
      setInputError(null);
      event.currentTarget.querySelector<HTMLInputElement>('input')?.blur();
      setEditingAddress(false);
      return true;
    } catch (error) {
      setInputError(error instanceof Error ? error.message : "Invalid address");
      return false;
    }
  };
  const currentUrl = page.navigation.currentUrl;
  const presentationFailed = presentationState === "failed" || Boolean(page.error);
  const presentationShowsFailure = presentationState !== "ready" && presentationFailed;
  const noticeMessage = inputError ?? (presentationShowsFailure ? null : page.error);

  return (
    <section className="browser-panel" data-mobile-browser={mobile || undefined} data-viewport-mode={tab.viewportMode.type} aria-label={page.title}>
      {mobile ? <Suspense fallback={null}><BrowserMobileToolbar page={page} tab={tab} panelTabId={panelTab.id}
        address={address} setAddress={setAddress} submit={submit}
        editing={editingAddress} setEditing={setEditingAddress}
        annotation={<BrowserAnnotationToggle touchChrome controller={annotation} blocked={agentControlled} />}
        toggleDevice={() => workbench.setViewportMode(tab.id, tab.viewportMode.type === 'responsive' ? FIT_VIEWPORT : { type: 'responsive' })} /></Suspense> : <form className="browser-panel__toolbar" onSubmit={submit}>
        <button type="button" className="browser-toolbar-button" disabled={!page.navigation.canGoBack}
          aria-label={intl.formatMessage({ id: "navigation.back", defaultMessage: "Back" })} title={intl.formatMessage({ id: "navigation.back", defaultMessage: "Back" })} onClick={() => pages.goBack(page.id)}>
          <ArrowLeft size={14} />
        </button>
        <button type="button" className="browser-toolbar-button" disabled={!page.navigation.canGoForward}
          aria-label={intl.formatMessage({ id: "navigation.forward", defaultMessage: "Forward" })} title={intl.formatMessage({ id: "navigation.forward", defaultMessage: "Forward" })} onClick={() => pages.goForward(page.id)}>
          <ArrowRight size={14} />
        </button>
        <button type="button" className="browser-toolbar-button"
          aria-label={intl.formatMessage(page.navigation.isLoading ? { id: "browser.stop", defaultMessage: "Stop" } : { id: "browser.reload", defaultMessage: "Reload" })}
          title={intl.formatMessage(page.navigation.isLoading ? { id: "browser.stop", defaultMessage: "Stop" } : { id: "browser.reload", defaultMessage: "Reload" })}
          onClick={() => page.navigation.isLoading ? pages.stop(page.id) : pages.reload(page.id)}>
          {page.navigation.isLoading ? <X size={13} /> : <RotateCw size={13} />}
        </button>
        <label className="browser-address-field" data-invalid={inputError !== null}>
          {page.navigation.isLoading
            ? <LoaderCircle className="browser-address-field__spinner" size={13} />
            : <Globe2 size={13} />}
          <input aria-label={intl.formatMessage({ id: "browser.address", defaultMessage: "Web address" })} autoCapitalize="none" autoCorrect="off"
            placeholder={intl.formatMessage({ id: "browser.address.placeholder", defaultMessage: "Enter a web address" })} spellCheck={false} value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => { setEditingAddress(true); event.currentTarget.select(); }}
            onBlur={() => setEditingAddress(false)} />
        </label>
        <button type="button" className="browser-toolbar-button" disabled={currentUrl === null}
          aria-label={intl.formatMessage({ id: "browser.external", defaultMessage: "Open in external browser" })} title={intl.formatMessage({ id: "browser.external", defaultMessage: "Open in external browser" })}
          onClick={() => currentUrl !== null && window.open(currentUrl, "_blank", "noopener,noreferrer")}>
          <ExternalLink size={13} />
        </button>
        <button type="button" className="browser-toolbar-button" aria-label={intl.formatMessage({ id: "browser.device", defaultMessage: "Toggle device toolbar" })} title={intl.formatMessage({ id: "browser.device", defaultMessage: "Toggle device toolbar" })}
          aria-pressed={tab.viewportMode.type !== "responsive"}
          onClick={()=>workbench.setViewportMode(tab.id,tab.viewportMode.type==="responsive"?FIT_VIEWPORT:{type:"responsive"})}>
          <MonitorSmartphone size={15}/>
        </button>
        <BrowserAnnotationToggle controller={annotation} blocked={agentControlled} />
        <BrowserResourcesButton surfaces={browserRuntime?.surfaces} workbench={workbench} ownerId={tab.ownerId} />
        <BrowserControlButton surfaces={browserRuntime?.surfaces} pageId={pageId} />
        <BrowserKeyboardButton surfaces={browserRuntime?.surfaces} pageId={pageId} />
        <FloatingComposerToggle activeTabId={panelTab.id} />
        {pages.supportsSiteSettings && currentUrl ? <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button type="button" className="browser-toolbar-button" aria-label={intl.formatMessage({ id: "browser.settings", defaultMessage: "Site settings" })} title={intl.formatMessage({ id: "browser.settings", defaultMessage: "Site settings" })}><Globe2 size={13} /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal container={portalContainer}><DropdownMenu.Content className="new-thread-project-menu" align="end" sideOffset={6} collisionPadding={8}>
            <DropdownMenu.Item className="new-thread-project-menu__item" onSelect={() => { void pages.siteSettings(page.id, "permissions").catch(error => setInputError(error.message)); }}>{intl.formatMessage({ id: "browser.permissions", defaultMessage: "Site permissions" })}</DropdownMenu.Item>
            <DropdownMenu.Item className="new-thread-project-menu__item" onSelect={() => { void pages.siteSettings(page.id, "clear-data").catch(error => setInputError(error.message)); }}>{intl.formatMessage({ id: "browser.clearData", defaultMessage: "Clear site data" })}</DropdownMenu.Item>
            <DropdownMenu.Separator className="new-thread-project-menu__separator" />
            <DropdownMenu.Item className="new-thread-project-menu__item" onSelect={() => { void pages.clearClosedData().catch((error: Error) => setInputError(error.message)); }}>{intl.formatMessage({ id: "browser.clearClosed", defaultMessage: "Clear closed tab data" })}</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root> : null}
      </form>}
      {tab.viewportMode.type!=="responsive"?<BrowserDeviceToolbar mode={tab.viewportMode}
        onChange={mode=>workbench.setViewportMode(tab.id,mode)}
        onClose={()=>workbench.setViewportMode(tab.id,{type:"responsive"})}
        zoom={zoom} onZoom={pages.supportsZoom?value=>{pages.setZoom(page.id,value);setZoom(value);}:undefined}/>:null}
      {noticeMessage ? (
        <div className="browser-panel__notice" role="status">
          <span>{noticeMessage}</span>
          {!presentationShowsFailure ? <div className="browser-panel__notice-actions">
            <IconButton size="sm"
              aria-label={intl.formatMessage({ id: "browser.reload", defaultMessage: "Reload" })}
              title={intl.formatMessage({ id: "browser.reload", defaultMessage: "Reload" })}
              onClick={() => { pages.reload(page.id); setInputError(null); }}><RotateCw size={16} aria-hidden="true" /></IconButton>
            {currentUrl !== null ? <IconButton size="sm"
              aria-label={intl.formatMessage({ id: "browser.external", defaultMessage: "Open in external browser" })}
              title={intl.formatMessage({ id: "browser.external", defaultMessage: "Open in external browser" })}
              onClick={() => window.open(currentUrl, "_blank", "noopener,noreferrer")}><ExternalLink size={16} aria-hidden="true" /></IconButton> : null}
          </div> : null}
        </div>
      ) : null}
      <div ref={slotRef} className="browser-viewport-slot"
        data-viewport-mode={tab.viewportMode.type}>
        {presentationState !== "ready" ? <div className="browser-panel__presentation-status">
          <div className="browser-panel__presentation-message" role="status">
            {presentationFailed
              ? <Globe2 size={20} aria-hidden="true" />
              : <LoaderCircle size={20} aria-hidden="true" className="browser-panel__presentation-spinner" />}
            <span>{intl.formatMessage(presentationFailed
            ? { id: "browser.presentation.failed", defaultMessage: "Unable to display this page" }
            : { id: "browser.presentation.loading", defaultMessage: "Opening page…" })}</span>
          </div>
          {presentationFailed ? <IconButton type="button" size="sm"
            aria-label={intl.formatMessage({ id: "browser.reload", defaultMessage: "Reload" })}
            title={intl.formatMessage({ id: "browser.reload", defaultMessage: "Reload" })}
            onClick={() => {
            pages.reload(page.id); setInputError(null); setPresentationAttempt(value => value + 1);
          }}><RotateCw size={16} aria-hidden="true" /></IconButton> : null}
        </div> : null}
        {tab.viewportMode.type!=="responsive"?<BrowserDeviceHandles mode={tab.viewportMode} slot={slotRef}
          onChange={mode=>workbench.setViewportMode(tab.id,mode)}/>:null}
      </div>
      <BrowserAnnotationLayer controller={annotation} slot={slotRef} portal={portalContainer ?? null} touch={newera} />
    </section>
  );
}
