import { createContext, useCallback, useContext, useEffect, useId, useMemo, useReducer, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast, Toaster } from "sonner";
import { AlertIcon, CheckedCircleIcon, CloseIcon, InfoIcon, WarningIcon } from "@opencraft/design-system-web/action-icons";
import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import "sonner/dist/styles.css";
import { useIntl } from "@opencraft/i18n/react";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import "./async-notices.scss";

import { reduceNoticeHistory, type OperationNotice, type NoticeRecord, type NoticeTone } from "./notice-history";
import { AsyncNoticesContext as Context, type AsyncNotices } from "./async-notices-context";
export { useAsyncNotices, useOptionalAsyncNotices } from "./async-notices-context";

const HistoryContext = createContext<{
  records: readonly NoticeRecord[];
  markRead(): void;
  clear(): void;
} | null>(null);

const noticeIcons = {
  success: <CheckedCircleIcon size={20} />,
  info: <InfoIcon size={20} />,
  warning: <WarningIcon size={20} />,
  error: <AlertIcon size={20} />,
  loading: <ProgressIndicator />,
  close: <CloseIcon size={14} />,
};

/** One notification owner per full/embedded Workbench, outside feature layout. */
export function AsyncNoticesProvider({ children }: { readonly children: ReactNode }) {
  const id = useId();
  const portal = useWorkbenchPresentationRoot();
  const intl = useIntl();
  const [records, dispatch] = useReducer(reduceNoticeHistory, []);
  const alive = useRef(true);
  const published = useRef(new Set<string>());
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; for (const key of published.current) toast.dismiss(key); published.current.clear(); };
  }, []);
  const publish = useCallback((tone: NoticeTone, notice: OperationNotice) => {
    if (!alive.current) return;
    const key = `${id}:${notice.key}`;
    dispatch({ type: "publish", notice, tone, now: Date.now() });
    published.current.add(key);
    const release = () => published.current.delete(key);
    toast[tone](notice.message, { id: key, toasterId: id, description: notice.detail, duration: 5000, closeButton: true,
      onDismiss: release, onAutoClose: release });
  }, [id]);
  const loading = useCallback((notice: OperationNotice) => {
    if (!alive.current) return;
    const key = `${id}:${notice.key}`;
    published.current.add(key);
    toast.loading(notice.message, { id: key, toasterId: id, description: notice.detail,
      duration: Infinity, closeButton: false });
  }, [id]);
  const dismiss = useCallback((key: string) => {
    if (!alive.current) return;
    const ownedKey = `${id}:${key}`;
    if (published.current.delete(ownedKey)) toast.dismiss(ownedKey);
  }, [id]);
  const dismissAll = useCallback(() => {
    for (const key of published.current) toast.dismiss(key);
    published.current.clear();
  }, []);
  const api = useMemo<AsyncNotices>(() => ({
    loading,
    info: notice => publish("info", notice),
    success: notice => publish("success", notice),
    warning: notice => publish("warning", notice),
    error: notice => publish("error", notice),
    dismiss, dismissAll,
  }), [publish, loading, dismiss, dismissAll]);
  const markRead = useCallback(() => dispatch({ type: "read" }), []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  const history = useMemo(() => ({ records, markRead, clear }), [records, markRead, clear]);
  return <Context.Provider value={api}>
    <HistoryContext.Provider value={history}>{children}</HistoryContext.Provider>
    {createPortal(<Toaster id={id} className="workbench-notices" position="top-right"
      icons={noticeIcons}
      duration={5000} visibleToasts={3} closeButton
      offset={{ top: "calc(var(--height-toolbar, 48px) + env(safe-area-inset-top, 0px) + 8px)", right: "12px" }}
      mobileOffset={{ top: "calc(var(--height-toolbar, 48px) + env(safe-area-inset-top, 0px) + 8px)", right: "12px", left: "12px" }}
      toastOptions={{ closeButtonAriaLabel: intl.formatMessage({ id: "common.close", defaultMessage: "Close" }) }}
    />, portal ?? document.body)}
  </Context.Provider>;
}

export function useNoticeHistory() {
  const history = useContext(HistoryContext);
  if (!history) throw new Error("Notice history requires the Workbench notification provider");
  return history;
}
